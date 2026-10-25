import type { Env } from "../worker/do/team";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
