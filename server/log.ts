// Short timestamped console logs. Never pass the session token or message text here.

export type Logger = (message: string) => void;

function time(): string {
  return new Date().toISOString().slice(11, 23);
}

export const consoleLogger: Logger = (message) => {
  console.log(`[${time()}] ${message}`);
};

export const silentLogger: Logger = () => {};
