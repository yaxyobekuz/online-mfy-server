import { requestContext } from "../utils/request-context.js";

export const authContext = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const [, token] = authHeader.split(" ");

  requestContext.run({ token }, next);
};
