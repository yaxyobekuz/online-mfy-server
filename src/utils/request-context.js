import { AsyncLocalStorage } from "node:async_hooks";

export const requestContext = new AsyncLocalStorage();
export const getRequestToken = () => requestContext.getStore()?.token;
export const getRequestUser = () => requestContext.getStore()?.user;
