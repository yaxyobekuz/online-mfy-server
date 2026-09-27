import "./src/config/env.js";

import connectDB from "./src/config/database.js";

// await connectDB();
await import("./src/services/getUser.service.js");
