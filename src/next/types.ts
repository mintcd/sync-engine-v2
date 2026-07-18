export interface NextSyncServer {
  readonly pull: (request: Request) => Response | Promise<Response>;
  readonly push: (request: Request) => Response | Promise<Response>;
}
