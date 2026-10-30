export interface CommandExecutionOutput {
  readonly output: string;
  readonly shouldExit: boolean;
}

export interface CreateCmdOptions {
  readonly id?: string;
  readonly amount?: string;
  readonly policyLimit?: string;
  readonly docs?: string;
  readonly notes?: string;
  readonly set?: string[];
}

export interface AdvanceCmdOptions {
  readonly role?: string;
  readonly user?: string;
  readonly notes?: string;
  readonly expectedVersion?: string;
  readonly idempotencyKey?: string;
  readonly set?: string[];
  readonly json?: string;
}
