/**
 * Bundle entrypoint for the standalone `claude-devin` CLI.
 *
 * Exports the proxy server (as the main run) plus the login + credential
 * helpers the CLI drives via `node --input-type=module -e "import {...}"`.
 */

export { createServer } from "./server.ts"
export { loginAuto, loginManual } from "./login.ts"
export {
  clearCredentials,
  credentialsPath,
  getApiKey,
  loadCredentials,
  saveCredentials,
  LOCAL_CLIENT_KEY,
} from "./auth.ts"

// When run directly (`node proxy-bundle.mjs`), boot the server.
import { createServer as bootServer } from "./server.ts"
import { getApiKey as readKey, LOCAL_CLIENT_KEY as KEY } from "./auth.ts"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const isMain =
  typeof process !== "undefined" &&
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const port = Number(process.env.DEVIN_CLAUDE_PORT) || 42100
  const clientKey = process.env.DEVIN_CLAUDE_CLIENT_KEY || KEY
  bootServer({ port, clientKey })
    .then(({ port: bound }) => console.log(`[devin-proxy] listening on http://127.0.0.1:${bound}`))
    .catch((err) => {
      console.error(`[devin-proxy] failed to start: ${(err as Error).message}`)
      process.exit(1)
    })
  if (!readKey()) {
    console.warn("[devin-proxy] warning: no Devin credential — run `claude-devin login`")
  }
}
