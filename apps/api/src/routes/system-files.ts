import {
  getSystemFilesStatus,
  listSystemFiles,
  readSystemFile,
  writeSystemFile,
} from "../system-files.js";
import type { RouterContext } from "./context.js";

export function systemFilesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    systemFiles: {
      status: authed.systemFiles.status.handler(({ context }) =>
        getSystemFilesStatus(deps, context.actor),
      ),
      list: authed.systemFiles.list.handler(({ context, input }) =>
        listSystemFiles(deps, context.actor, input),
      ),
      read: authed.systemFiles.read.handler(({ context, input }) =>
        readSystemFile(deps, context.actor, input),
      ),
      write: authed.systemFiles.write.handler(({ context, input }) =>
        writeSystemFile(deps, context.actor, input),
      ),
    },
  };
}
