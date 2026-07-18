type ConsoleError = typeof console.error;
type ConsoleErrorArguments = Parameters<ConsoleError>;

export async function suppressSuccessfulWorkerdSocketNoise<T>(
  callback: () => Promise<T>,
): Promise<T> {
  const originalError: ConsoleError = console.error;
  const suppressed: ConsoleErrorArguments[] = [];
  let suppressNextWorkerdContextLine = false;

  console.error = ((...args: ConsoleErrorArguments) => {
    const message = args.map(toDiagnosticText).join(" ");
    if (isWorkerdSocketErrorLine(message)) {
      suppressed.push(args);
      suppressNextWorkerdContextLine = true;
      return;
    }
    if (
      suppressNextWorkerdContextLine &&
      isWorkerdSocketErrorContextLine(message)
    ) {
      suppressed.push(args);
      suppressNextWorkerdContextLine = false;
      return;
    }
    suppressNextWorkerdContextLine = false;
    originalError.apply(console, args);
  }) as ConsoleError;

  try {
    return await callback();
  } catch (error) {
    for (const args of suppressed) {
      originalError.apply(console, args);
    }
    throw error;
  } finally {
    console.error = originalError;
  }
}

function isWorkerdSocketErrorLine(message: string): boolean {
  return (
    message.includes("workerd/jsg/util.c++") &&
    message.includes("WSARecv(): #64") &&
    message.includes("The specified network name is no longer available")
  );
}

function isWorkerdSocketErrorContextLine(message: string): boolean {
  return (
    message.includes("stack:") &&
    message.includes("sentryErrorContext = jsgInternalError")
  );
}

function toDiagnosticText(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  return String(value);
}
