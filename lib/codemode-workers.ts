/**
 * pi lets two codemode workers live per process. The CLI runs one session per
 * process; pi-web runs every session and in-process subagent in one, and a
 * script that calls subagents holds its worker until they return, so two
 * workers are taken by two such scripts and the subagents' own scripts wait
 * out pi's 60 s and fail. pi reads `PI_CODEMODE_MAX_WORKERS` on every script
 * for SDK hosts like this one; a value the user set, valid or not, is kept.
 */
export const PI_WEB_CODEMODE_MAX_WORKERS = 8;

export function applyCodemodeWorkerDefault(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PI_CODEMODE_MAX_WORKERS === undefined || env.PI_CODEMODE_MAX_WORKERS === "") {
    env.PI_CODEMODE_MAX_WORKERS = String(PI_WEB_CODEMODE_MAX_WORKERS);
  }
}
