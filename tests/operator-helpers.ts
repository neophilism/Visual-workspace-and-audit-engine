import { DomainError } from "@accountability/correspondence/contracts";
import {
  createAlphaCorrespondenceFixture,
  transitionCorrespondence,
} from "@accountability/correspondence";
import { createOperatorHandler } from "@accountability/correspondence/operator";
import { OperatorClient } from "../src/operator-client.ts";
export function fixture() {
  const f = createAlphaCorrespondenceFixture();
  let state = f.state;
  const context = f.steps[0]!.context;
  const requests: any[] = [];
  const handler = createOperatorHandler(
    {
      load: async () => structuredClone(state),
      execute: async (c, _id, expected, command) => {
        if (
          expected !== state.revision &&
          !state.receipts.some((r) => r.inputId === command.inputId)
        )
          throw new DomainError("revision_conflict", "State changed");
        const result = transitionCorrespondence(state, c, command);
        state = result.state;
        return result;
      },
    },
    { authenticate: async () => ({ context, csrfToken: "c".repeat(43) }) },
    {
      tenantId: state.tenantId,
      projectId: state.projectId,
      mailboxId: state.mailbox.id,
      origin: "https://workspace.example",
    },
  );
  const transport: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return handler(new Request(input, init));
  };
  return {
    client: new OperatorClient("https://workspace.example", transport),
    transport,
    requests,
    get state() {
      return state;
    },
  };
}
