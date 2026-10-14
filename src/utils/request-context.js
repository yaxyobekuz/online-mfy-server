import { AsyncLocalStorage } from "node:async_hooks";

export const requestContext = new AsyncLocalStorage();
export const getRequestToken = () => requestContext.getStore()?.token;
export const getRequestUser = () => requestContext.getStore()?.user;
// Joriy so'rov qaysi MFY ustida ishlayotgani (uid).
export const getRequestMahallaUid = () =>
  requestContext.getStore()?.mahallaUid;
