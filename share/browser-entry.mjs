import * as validators from '#share-validators';
import { corpus, tickets, provenance } from '#share-data';
import { createBrowserApi } from './engine.mjs';

let handler;
window.supportLabCloudApi = async (path, value) => {
  handler ??= createBrowserApi({ corpus, tickets, provenance, validators, storage: window.localStorage });
  return handler(path, value);
};
