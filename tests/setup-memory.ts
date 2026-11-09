import { vi } from "vitest";

// A launch reads the host's free memory; pin it so no test depends on the RAM of the PC running the suite.
// Tests of the memory check inject their own reading on the client.
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), freemem: () => 16 * 2 ** 30 }));
