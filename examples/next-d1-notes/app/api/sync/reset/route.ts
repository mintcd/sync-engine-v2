import { resetSyncAuthorities } from "../../../sync/server";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const streamId = await readStreamId(request);
  await resetSyncAuthorities(streamId);
  return Response.json({
    ok: true,
    ...(streamId === undefined ? {} : { streamId }),
  });
}

async function readStreamId(request: Request): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  if (
    body !== null &&
    typeof body === "object" &&
    typeof (body as { streamId?: unknown }).streamId === "string"
  ) {
    const streamId = (body as { streamId: string }).streamId.trim();
    return streamId === "" ? undefined : streamId;
  }
  return undefined;
}
