#!/usr/bin/env node
const command = process.argv[2];
if (command === "login") {
    await import("./qr-login-cli.js");
}
else {
    await import("./index.js");
}
export {};
