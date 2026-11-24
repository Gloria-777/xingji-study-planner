import { createDatabaseClient, createSiteContext, errorResponse, BackendError } from './_qoder/backend.mjs';
import { storage } from './_qoder/storage.mjs';
import { application } from './routes.mjs';

const handle = application({
  db: createDatabaseClient(),
  env: (name: string) => Deno.env.get(name),
  storage,
  BackendError,
});

Deno.serve(async (request) => {
  let context;
  try {
    context = createSiteContext(request);
    return await handle(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
