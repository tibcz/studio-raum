export type ErrorCode =
  | "noTeam"
  | "invalidTime"
  | "studioUnavailable"
  | "dataLimitExceeded"
  | "memberDisabled"
  | "memberPending"
  | "teamFull"
  | "readOnly"
  | "joinClosed"
  | "invalidText"
  | "bookingConflict"
  | "permissionDenied"
  | "requestNoLongerAvailable"
  | "invalidSecret"
  | "notAuthenticated"
  | "rateLimited"
  | "notFound"
  | "badRequest"
  | "conflict"
  | "requestNotAllowed"
  | "noStudioAvailable"
  | "standingConflict"
  | "setupPassword"
  | "setupMissing"
  | "instanceFull";

const MESSAGES: Record<ErrorCode, string> = {
  noTeam: "No team was found yet.",
  invalidTime: "Choose a valid time range in 15-minute steps.",
  studioUnavailable: "This studio is no longer available. Please reload the room plan.",
  dataLimitExceeded: "The team holds an unusual number of records. Please contact the owner.",
  memberDisabled: "Your membership has been deactivated. Please contact the owner.",
  memberPending: "An admin still has to approve your membership.",
  teamFull: "This team has reached its maximum number of members. Please contact the owner.",
  readOnly: "You joined with view-only access and can only look at the room plan.",
  joinClosed: "Joining this team is currently closed. Please contact the owner.",
  invalidText: "The text you entered is empty or invalid.",
  bookingConflict: "This time range has been taken in the meantime. Please refresh the room plan and pick a free time.",
  permissionDenied: "You are not allowed to make this change.",
  requestNoLongerAvailable: "The request is no longer current. Please reload the room plan.",
  invalidSecret: "This secret is invalid or has been withdrawn.",
  notAuthenticated: "Please sign in with your personal secret.",
  rateLimited: "Too many attempts. Please wait a moment and try again.",
  notFound: "The requested entry does not exist.",
  badRequest: "The request was incomplete or malformed.",
  conflict: "The data was changed at the same time. Please reload and try again.",
  requestNotAllowed: "This time range is marked as occupied. Requests are not possible here.",
  noStudioAvailable: "No studio is free in this time range and none can be requested.",
  standingConflict: "This standing booking overlaps another one in the same studio.",
  setupPassword: "The setup password is not right. It is the one you chose when you deployed Studio Raum.",
  setupMissing: "This copy has no setup password yet. Add SETUP_PASSWORD in Cloudflare (Worker, Settings, Variables and Secrets), then try again.",
  instanceFull: "This copy of Studio Raum already has its team. Ask its owner for the team secret to join.",
};

const STATUS: Partial<Record<ErrorCode, number>> = {
  invalidTime: 422,
  studioUnavailable: 409,
  dataLimitExceeded: 507,
  memberDisabled: 403,
  memberPending: 403,
  teamFull: 409,
  readOnly: 403,
  joinClosed: 403,
  invalidText: 422,
  bookingConflict: 409,
  permissionDenied: 403,
  requestNoLongerAvailable: 409,
  invalidSecret: 401,
  notAuthenticated: 401,
  rateLimited: 429,
  notFound: 404,
  badRequest: 400,
  conflict: 409,
  noTeam: 404,
  requestNotAllowed: 409,
  noStudioAvailable: 409,
  standingConflict: 409,
  setupPassword: 401,
  setupMissing: 403,
  instanceFull: 409,
};

export class StudioRaumError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? MESSAGES[code]);
    this.name = "StudioRaumError";
    this.code = code;
    this.status = STATUS[code] ?? 400;
  }

  static message(code: ErrorCode): string {
    return MESSAGES[code];
  }
}

export function fail(code: ErrorCode, message?: string): never {
  throw new StudioRaumError(code, message);
}

const RPC_MARKER = "SRERR";

export function encodeErrorForRpc(error: unknown): Error {
  if (error instanceof StudioRaumError) {
    return new Error(`${RPC_MARKER}|${error.code}|${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function decodeErrorFromRpc(error: unknown): unknown {
  if (!(error instanceof Error) || !error.message.startsWith(`${RPC_MARKER}|`)) return error;
  const [, code, ...rest] = error.message.split("|");
  return new StudioRaumError(code as ErrorCode, rest.join("|"));
}
