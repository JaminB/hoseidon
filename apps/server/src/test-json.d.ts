// Route tests read JSON bodies without schemas; newer lib types make Response.json() return
// `unknown`. This overload (merged first) keeps those tests terse.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Response {
  json(): Promise<any>;
}
