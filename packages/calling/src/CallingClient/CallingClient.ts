/* eslint-disable no-underscore-dangle */
/* eslint-disable valid-jsdoc */
/* eslint-disable @typescript-eslint/no-shadow */
import * as Media from '@webex/internal-media-core';
import {Mutex} from 'async-mutex';
import {filterMobiusUris, handleCallingClientErrors, validateServiceData} from '../common/Utils';
import {ERROR_TYPE} from '../Errors/types';
import {LOGGER, LogContext} from '../Logger/types';
import SDKConnector from '../SDKConnector';
import {ClientRegionInfo, ISDKConnector, WebexSDK} from '../SDKConnector/types';
import {Eventing} from '../Events/impl';
import {
  EVENT_KEYS,
  CallingClientEventTypes,
  MOBIUS_EVENT_KEYS,
  CallSessionEvent,
  SessionType,
} from '../Events/types';
import {
  MobiusStatus,
  CallDirection,
  CallDetails,
  CorrelationId,
  ServiceIndicator,
  RegionInfo,
  ALLOWED_SERVICES,
  HTTP_METHODS,
  IpInfo,
  MobiusServers,
  WebexRequestPayload,
} from '../common/types';
import {ICallingClient, CallingClientConfig} from './types';
import {ICall, ICallManager} from './calling/types';
import log from '../Logger';
import {getCallManager} from './calling/callManager';
import {
  CALLING_CLIENT_FILE,
  VALID_PHONE,
  CALLS_CLEARED_HANDLER_UTIL,
  CALLING_USER_AGENT,
  CISCO_DEVICE_URL,
  DISCOVERY_URL,
  GET_MOBIUS_SERVERS_UTIL,
  IP_ENDPOINT,
  SPARK_USER_AGENT,
  URL_ENDPOINT,
  NETWORK_FLAP_TIMEOUT,
} from './constants';
import {CallingClientError} from '../Errors';
import Line from './line';
import {ILine, LINE_EVENTS, LineStatus} from './line/types';
import {METRIC_EVENT, REG_ACTION, METRIC_TYPE, IMetricManager} from '../Metrics/types';
import {getMetricManager} from '../Metrics';

/**
 *
 */
export class CallingClient extends Eventing<CallingClientEventTypes> implements ICallingClient {
  private sdkConnector: ISDKConnector;

  private webex: WebexSDK;

  private mutex: Mutex;

  private callManager: ICallManager;

  private metricManager: IMetricManager;

  private sdkConfig?: CallingClientConfig;

  private primaryMobiusUris: string[];

  private backupMobiusUris: string[];

  public mediaEngine: typeof Media;

  private lineDict: Record<string, ILine> = {};

  /**
   * @param webex - A webex instance.
   * @param config - Config to start the CallingClient with.
   */
  constructor(webex: WebexSDK, config?: CallingClientConfig) {
    super();
    this.sdkConnector = SDKConnector;

    if (!this.sdkConnector.getWebex()) {
      SDKConnector.setWebex(webex);
    }
    this.mutex = new Mutex();
    this.webex = this.sdkConnector.getWebex();

    this.sdkConfig = config;
    const serviceData = this.sdkConfig?.serviceData?.indicator
      ? this.sdkConfig.serviceData
      : {indicator: ServiceIndicator.CALLING, domain: ''};

    const logLevel = this.sdkConfig?.logger?.level ? this.sdkConfig.logger.level : LOGGER.ERROR;
    validateServiceData(serviceData);

    this.callManager = getCallManager(this.webex, serviceData.indicator);
    this.metricManager = getMetricManager(this.webex, serviceData.indicator);

    this.mediaEngine = Media;

    this.primaryMobiusUris = [];
    this.backupMobiusUris = [];

    this.registerSessionsListener();

    log.setLogger(logLevel, CALLING_CLIENT_FILE);

    this.incomingCallListener();
    this.registerCallsClearedListener();
  }

  // async calls required to run after constructor
  public async init() {
    await this.getMobiusServers();
    await this.createLine();

    /* Better to run the timer once rather than after every registration */
    this.detectNetworkChange();
  }

  /**
   * An Incoming Call listener.
   */
  private incomingCallListener() {
    const logContext = {
      file: CALLING_CLIENT_FILE,
      method: this.incomingCallListener.name,
    };

    log.log('Listening for incoming calls... ', logContext);
    this.callManager.on(EVENT_KEYS.INCOMING_CALL, (callObj: ICall) => {
      this.emit(EVENT_KEYS.INCOMING_CALL, callObj);
    });
  }

  /**
   * Register callbacks for network changes.
   */
  private async detectNetworkChange() {
    let retry = false;

    // this is a temporary logic to get registration obj
    // it will change once we have proper lineId and multiple lines as well
    const line = Object.values(this.lineDict)[0];

    setInterval(async () => {
      if (
        !this.webex.internal.mercury.connected &&
        !retry &&
        !Object.keys(this.callManager.getActiveCalls()).length
      ) {
        log.warn(`Network has flapped, waiting for mercury connection to be up`, {
          file: CALLING_CLIENT_FILE,
          method: this.detectNetworkChange.name,
        });

        line.lineEmitter(LINE_EVENTS.UNREGISTERED);
        line.registration.clearKeepaliveTimer();

        retry = true;
      }

      if (retry && this.webex.internal.mercury.connected) {
        retry = await line.registration.handleConnectionRestoration(retry);
      }
    }, NETWORK_FLAP_TIMEOUT);
  }

  /**
   * Fetches countryCode and region of the client.
   */
  private async getClientRegionInfo(): Promise<RegionInfo> {
    const regionInfo = {} as RegionInfo;

    try {
      const temp = <WebexRequestPayload>await this.webex.request({
        uri: `${this.webex.internal.services._serviceUrls.mobius}${URL_ENDPOINT}${IP_ENDPOINT}`,
        method: HTTP_METHODS.GET,
        headers: {
          [CISCO_DEVICE_URL]: this.webex.internal.device.url,
          [SPARK_USER_AGENT]: CALLING_USER_AGENT,
        },
        service: ALLOWED_SERVICES.MOBIUS,
      });

      const myIP = (temp.body as IpInfo).ipv4;
      const response = <WebexRequestPayload>await this.webex.request({
        uri: `${DISCOVERY_URL}/${myIP}`,
        method: HTTP_METHODS.GET,
        addAuthHeader: false,
        headers: {
          [SPARK_USER_AGENT]: null,
        },
      });

      const clientRegionInfo = response.body as ClientRegionInfo;

      regionInfo.clientRegion = clientRegionInfo?.clientRegion ? clientRegionInfo.clientRegion : '';

      regionInfo.countryCode = clientRegionInfo?.countryCode ? clientRegionInfo.countryCode : '';
    } catch (err: unknown) {
      handleCallingClientErrors(
        err as WebexRequestPayload,
        (clientError) => {
          this.metricManager.submitRegistrationMetric(
            METRIC_EVENT.REGISTRATION_ERROR,
            REG_ACTION.REGISTER,
            METRIC_TYPE.BEHAVIORAL,
            clientError
          );
          this.emit(EVENT_KEYS.ERROR, clientError);
        },
        {method: GET_MOBIUS_SERVERS_UTIL, file: CALLING_CLIENT_FILE}
      );
      regionInfo.clientRegion = '';
      regionInfo.countryCode = '';
    }

    return regionInfo;
  }

  /**
   * Local method for finding the mobius servers.
   */
  private async getMobiusServers() {
    /* Following operations are performed in a synchronous way ->

        1. Get RegionInfo
        2. Get Mobius Server with that RegionInfo
        3. Check whether Mobius server was found without any error
        4. If there is error , we don't need to send registration
        5. Otherwise send registration
        */

    let useDefault = false;

    let clientRegion: string;
    let countryCode: string;

    if (this.sdkConfig?.discovery?.country && this.sdkConfig?.discovery?.region) {
      log.info('Updating region and country from the SDK config', {
        file: CALLING_CLIENT_FILE,
        method: GET_MOBIUS_SERVERS_UTIL,
      });
      clientRegion = this.sdkConfig?.discovery?.region;
      countryCode = this.sdkConfig?.discovery?.country;
    } else {
      log.info('Updating region and country through Region discovery', {
        file: CALLING_CLIENT_FILE,
        method: GET_MOBIUS_SERVERS_UTIL,
      });

      const regionInfo = await this.getClientRegionInfo();

      clientRegion = regionInfo.clientRegion;
      countryCode = regionInfo.countryCode;
    }

    if (clientRegion && countryCode) {
      log.log(
        `Found Region: ${clientRegion} and country: ${countryCode}, going to fetch Mobius server`,
        '' as LogContext
      );

      try {
        const temp = <WebexRequestPayload>await this.webex.request({
          uri: `${this.webex.internal.services._serviceUrls.mobius}${URL_ENDPOINT}?regionCode=${clientRegion}&countryCode=${countryCode}`,
          method: HTTP_METHODS.GET,
          headers: {
            [CISCO_DEVICE_URL]: this.webex.internal.device.url,
            [SPARK_USER_AGENT]: CALLING_USER_AGENT,
          },
          service: ALLOWED_SERVICES.MOBIUS,
        });

        log.log('Mobius Server found for the region', '' as LogContext);
        const mobiusServers = temp.body as MobiusServers;

        /* update arrays of Mobius Uris. */
        const mobiusUris = filterMobiusUris(
          mobiusServers,
          this.webex.internal.services._serviceUrls.mobius
        );
        this.primaryMobiusUris = mobiusUris.primary;
        this.backupMobiusUris = mobiusUris.backup;
        log.info(
          `Final list of Mobius Servers, primary: ${mobiusUris.primary} and backup: ${mobiusUris.backup}`,
          '' as LogContext
        );
      } catch (err: unknown) {
        handleCallingClientErrors(
          err as WebexRequestPayload,
          (clientError) => {
            this.metricManager.submitRegistrationMetric(
              METRIC_EVENT.REGISTRATION_ERROR,
              REG_ACTION.REGISTER,
              METRIC_TYPE.BEHAVIORAL,
              clientError
            );
            this.emit(EVENT_KEYS.ERROR, clientError);
          },
          {method: GET_MOBIUS_SERVERS_UTIL, file: CALLING_CLIENT_FILE}
        );

        useDefault = true;
      }
    } else {
      /* Setting this to true because region info is possibly undefined */
      useDefault = true;
    }

    /* Use a default URL if Mobius discovery fails either because of region info failure
     * or because the discovered Mobius couldn't be reached
     */

    if (useDefault) {
      log.warn('Error in finding Mobius Servers. Will use the default URL.', '' as LogContext);
      this.primaryMobiusUris = [
        `${this.webex.internal.services._serviceUrls.mobius}${URL_ENDPOINT}`,
      ];
    }
  }

  /**
   * Registers a listener/handler for ALL_CALLS_CLEARED
   * event emitted by callManager when all the calls
   * present on sdk are cleaned up.
   */
  private registerCallsClearedListener() {
    const logContext = {
      file: CALLING_CLIENT_FILE,
      method: this.registerCallsClearedListener.name,
    };

    log.log('Registering listener for all calls cleared event', logContext);
    this.callManager.on(EVENT_KEYS.ALL_CALLS_CLEARED, this.callsClearedHandler);
  }

  /**
   * Handler registered for ALL_CALLS_CLEARED event emitted by callManager.
   *
   * If re-register attempt was deferred earlier due to active call(s), then it
   * will be attempted here on receiving a notification from callManager that all
   * calls are cleaned up.
   */
  private callsClearedHandler = async () => {
    // this is a temporary logic to get registration obj
    // it will change once we have proper lineId and multiple lines as well
    const {registration} = Object.values(this.lineDict)[0];

    if (!registration.isDeviceRegistered()) {
      await this.mutex.runExclusive(async () => {
        if (registration.isReconnectPending()) {
          log.log('All calls cleared, reconnecting', {
            file: CALLING_CLIENT_FILE,
            method: CALLS_CLEARED_HANDLER_UTIL,
          });
          await registration.reconnectOnFailure(CALLS_CLEARED_HANDLER_UTIL);
        }
      });
    }
  };

  /**
   * To get the current log Level.
   *
   * @returns - Log level.
   */
  public getLoggingLevel(): LOGGER {
    return log.getLogLevel();
  }

  /**
   * @param callId -.
   * @param correlationId -.
   */
  public getCall = (correlationId: CorrelationId): ICall => {
    return this.callManager.getCall(correlationId);
  };

  /**
   * @param dest -.
   */
  public makeCall = (dest: CallDetails): ICall | undefined => {
    let call;

    // this is a temporary logic to get registration obj
    // it will change once we have proper lineId and multiple lines as well
    const {registration} = Object.values(this.lineDict)[0];

    if (dest) {
      const match = dest.address.match(VALID_PHONE);

      if (match && match[0].length === dest.address.length) {
        const sanitizedNumber = dest.address
          .replace(/[^[*+]\d#]/gi, '')
          .replace(/\s+/gi, '')
          .replace(/-/gi, '');
        const formattedDest = {
          type: dest.type,
          address: `tel:${sanitizedNumber}`,
        };

        call = this.callManager.createCall(
          formattedDest,
          CallDirection.OUTBOUND,
          registration.getDeviceInfo().device?.deviceId as string
        );
        log.log(`New call created, callId: ${call.getCallId()}`, {});
      } else {
        log.warn('Invalid phone number detected', {});
        const err = new CallingClientError(
          'An invalid phone number was detected. Check the number and try again.',
          {},
          ERROR_TYPE.CALL_ERROR,
          MobiusStatus.ACTIVE
        );

        this.emit(EVENT_KEYS.ERROR, err);
      }

      return call;
    }

    return undefined;
  };

  /**
   *
   */
  public getSDKConnector(): ISDKConnector {
    return this.sdkConnector;
  }

  /**
   *
   */
  private registerSessionsListener() {
    this.sdkConnector.registerListener<CallSessionEvent>(
      MOBIUS_EVENT_KEYS.CALL_SESSION_EVENT_INCLUSIVE,
      async (event?: CallSessionEvent) => {
        if (event && event.data.userSessions.userSessions) {
          const sessionArr = event?.data.userSessions.userSessions;

          if (sessionArr.length === 1) {
            if (sessionArr[0].sessionType !== SessionType.WEBEX_CALLING) {
              return;
            }
          }

          for (let i = 0; i < sessionArr.length; i += 1) {
            if (sessionArr[i].sessionType !== SessionType.WEBEX_CALLING) {
              sessionArr.splice(i, 1);
            }
          }
          this.emit(EVENT_KEYS.USER_SESSION_INFO, event as CallSessionEvent);
        }
      }
    );
  }

  /**
   * Creates line object inside calling client per user
   * NOTE: currently multiple lines are not supported
   */
  private async createLine(): Promise<void> {
    const line = new Line(
      this.webex.internal.device.userId,
      this.webex.internal.device.url,
      LineStatus.INACTIVE,
      this.mutex,
      this.primaryMobiusUris,
      this.backupMobiusUris,
      this.getLoggingLevel(),
      this.sdkConfig?.serviceData
    );

    this.lineDict[line.lineId] = line;
  }

  /**
   * Retrieves details of all the line objects belonging to a User
   * NOTE: currently multiple lines are not supported
   * so this API will return a single line object
   */
  public getLines(): Record<string, ILine> {
    return this.lineDict;
  }
}

/**
 * @param webex - A webex instance.
 * @param config - Config to start the CallingClient with..
 */
export const createClient = async (
  webex: WebexSDK,
  config?: CallingClientConfig
): Promise<ICallingClient> => {
  const callingClientInstance = new CallingClient(webex, config);
  await callingClientInstance.init();

  return callingClientInstance;
};