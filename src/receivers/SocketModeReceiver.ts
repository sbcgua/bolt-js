/* eslint-disable @typescript-eslint/no-explicit-any */
import { URL } from 'url';
import { SocketModeClient } from '@slack/socket-mode';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { Logger, ConsoleLogger, LogLevel } from '@slack/logger';
import { InstallProvider, CallbackOptions, InstallProviderOptions, InstallURLOptions } from '@slack/oauth';
import { AppsConnectionsOpenResponse } from '@slack/web-api';
import App from '../App';
import { Receiver, ReceiverEvent } from '../types';
import defaultRenderHtmlForInstallPath from './render-html-for-install-path';
import { StringIndexed } from '../types/helpers';
import { prepareRoutes, ReceiverRoutes } from './custom-routes';
import { verifyRedirectOpts } from './verify-redirect-opts';

// TODO: we throw away the key names for endpoints, so maybe we should use this interface. is it better for migrations?
// if that's the reason, let's document that with a comment.
export interface SocketModeReceiverOptions {
  logger?: Logger;
  logLevel?: LogLevel;
  clientId?: string;
  clientSecret?: string;
  stateSecret?: InstallProviderOptions['stateSecret']; // required when using default stateStore
  redirectUri?: string;
  installationStore?: InstallProviderOptions['installationStore']; // default MemoryInstallationStore
  scopes?: InstallURLOptions['scopes'];
  installerOptions?: InstallerOptions;
  appToken: string; // App Level Token
  customRoutes?: CustomRoute[];
  customPropertiesExtractor?: (args: any) => StringIndexed;
}

export interface CustomRoute {
  path: string;
  method: string | string[];
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

// Additional Installer Options
interface InstallerOptions {
  stateStore?: InstallProviderOptions['stateStore']; // default ClearStateStore
  stateVerification?: InstallProviderOptions['stateVerification']; // default true
  authVersion?: InstallProviderOptions['authVersion']; // default 'v2'
  metadata?: InstallURLOptions['metadata'];
  installPath?: string;
  directInstall?: boolean; // see https://api.slack.com/start/distributing/directory#direct_install
  renderHtmlForInstallPath?: (url: string) => string;
  redirectUriPath?: string;
  callbackOptions?: CallbackOptions;
  userScopes?: InstallURLOptions['userScopes'];
  clientOptions?: InstallProviderOptions['clientOptions'];
  authorizationUrl?: InstallProviderOptions['authorizationUrl'];
  port?: number; // used to create a server when doing OAuth or serving custom routes
}

/**
 * Receives Events, Slash Commands, and Actions of a web socket connection
 */
export default class SocketModeReceiver implements Receiver {
  /* Express app */
  public client: SocketModeClient;

  private app: App | undefined;

  private logger: Logger;

  public installer: InstallProvider | undefined = undefined;

  private httpServer?: Server;

  private httpServerPort?: number;

  private routes: ReceiverRoutes;

  public constructor({
    appToken,
    logger = undefined,
    logLevel = LogLevel.INFO,
    clientId = undefined,
    clientSecret = undefined,
    stateSecret = undefined,
    redirectUri = undefined,
    installationStore = undefined,
    scopes = undefined,
    installerOptions = {},
    customRoutes = [],
    customPropertiesExtractor = (_args) => ({}),
  }: SocketModeReceiverOptions) {
    this.client = new SocketModeClient({
      appToken,
      logLevel,
      logger,
      clientOptions: installerOptions.clientOptions,
    });

    this.logger = logger ?? (() => {
      const defaultLogger = new ConsoleLogger();
      defaultLogger.setLevel(logLevel);
      return defaultLogger;
    })();
    this.routes = prepareRoutes(customRoutes);

    // Verify redirect options if supplied, throws coded error if invalid
    verifyRedirectOpts({ redirectUri, redirectUriPath: installerOptions.redirectUriPath });

    if (
      clientId !== undefined &&
      clientSecret !== undefined &&
       (installerOptions.stateVerification === false || // state store not needed
         stateSecret !== undefined ||
          installerOptions.stateStore !== undefined) // user provided state store
    ) {
      this.installer = new InstallProvider({
        clientId,
        clientSecret,
        stateSecret,
        installationStore,
        logLevel,
        logger, // pass logger that was passed in constructor, not one created locally
        stateStore: installerOptions.stateStore,
        stateVerification: installerOptions.stateVerification,
        authVersion: installerOptions.authVersion ?? 'v2',
        clientOptions: installerOptions.clientOptions,
        authorizationUrl: installerOptions.authorizationUrl,
      });
    }

    // Add OAuth and/or custom routes to receiver
    if (this.installer !== undefined || customRoutes.length) {
      // use default or passed in redirect path
      const redirectUriPath = installerOptions.redirectUriPath === undefined ? '/slack/oauth_redirect' : installerOptions.redirectUriPath;

      // use default or passed in installPath
      const installPath = installerOptions.installPath === undefined ? '/slack/install' : installerOptions.installPath;
      const directInstallEnabled = installerOptions.directInstall !== undefined && installerOptions.directInstall;
      this.httpServerPort = installerOptions.port === undefined ? 3000 : installerOptions.port;

      this.httpServer = createServer(async (req, res) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const method = req.method!.toUpperCase();

        // Handle OAuth-related requests
        if (this.installer) {
          // create install url options
          const installUrlOptions = {
            metadata: installerOptions.metadata,
            scopes: scopes ?? [],
            userScopes: installerOptions.userScopes,
            redirectUri,
          };
          // Installation has been initiated
          if (req.url && req.url.startsWith(redirectUriPath)) {
            const { stateVerification, callbackOptions } = installerOptions;
            if (stateVerification === false) {
              // if stateVerification is disabled make install options available to handler
              // since they won't be encoded in the state param of the generated url
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              await this.installer!.handleCallback(req, res, callbackOptions, installUrlOptions);
            } else {
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              await this.installer!.handleCallback(req, res, callbackOptions);
            }
            return;
          }

          // Visiting the installation endpoint
          if (req.url && req.url.startsWith(installPath)) {
            const { stateVerification, renderHtmlForInstallPath } = installerOptions;
            try {
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              const url = await this.installer!.generateInstallUrl(installUrlOptions, stateVerification);
              if (directInstallEnabled) {
                res.writeHead(302, { Location: url });
                res.end('');
              } else {
                res.writeHead(200, {});
                const renderHtml = renderHtmlForInstallPath !== undefined ?
                  renderHtmlForInstallPath :
                  defaultRenderHtmlForInstallPath;
                res.end(renderHtml(url));
                return;
              }
            } catch (err) {
              const e = err as any;
              throw new Error(e);
            }
          }
        }

        // Handle request for custom routes
        if (customRoutes.length && req.url) {
          // NOTE: the domain and scheme are irrelevant here.
          // The URL object is only used to safely obtain the path to match
          const { pathname: path } = new URL(req.url as string, 'http://localhost');
          const match = this.routes[path] && this.routes[path][method] !== undefined;

          if (match) {
            this.routes[path][method](req, res);
            return;
          }
        }

        this.logger.info(`An unhandled HTTP request (${req.method}) made to ${req.url} was ignored`);
        res.writeHead(404, {});
        res.end();
      });

      this.logger.debug(`Listening for HTTP requests on port ${this.httpServerPort}`);

      if (this.installer) {
        this.logger.debug(`Go to http://localhost:${this.httpServerPort}${installPath} to initiate OAuth flow`);
      }
    }

    this.client.on('slack_event', async (args) => {
      const { ack, body, retry_num, retry_reason } = args;
      const event: ReceiverEvent = {
        body,
        ack,
        retryNum: retry_num,
        retryReason: retry_reason,
        customProperties: customPropertiesExtractor(args),
      };
      await this.app?.processEvent(event);
    });
  }

  public init(app: App): void {
    this.app = app;
  }

  public start(): Promise<AppsConnectionsOpenResponse> {
    if (this.httpServer !== undefined) {
      // This HTTP server is only for the OAuth flow support
      this.httpServer.listen(this.httpServerPort);
    }
    // start socket mode client
    return this.client.start();
  }

  public stop(): Promise<void> {
    if (this.httpServer !== undefined) {
      // This HTTP server is only for the OAuth flow support
      this.httpServer.close((error) => {
        if (error) this.logger.error(`Failed to shutdown the HTTP server for OAuth flow: ${error}`);
      });
    }
    return new Promise((resolve, reject) => {
      try {
        this.client.disconnect();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }
}
