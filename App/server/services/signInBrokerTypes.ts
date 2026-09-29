/** Provider-owned credentials are validated by the adapter and its consumer. */
export type HostedSignInCredential = {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  email?: string;
};

export type SignInRegistration = { clientId: string; clientSecret: string };
export type SignInExchange = SignInRegistration & {
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

export type SignInProvider = {
  id: string;
  /** Shared across protocol aliases so aliases cannot multiply rate budgets. */
  throttlePrefix: string;
  authorizationOrigin: string;
  page: { title: string; introduction: string; explanation: string; continueLabel: string };
  messages: { cancelled: string; completed: string; failed: string };
  registration(): Promise<SignInRegistration | null>;
  authorize(args: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
  }): string;
  exchange(args: SignInExchange): Promise<HostedSignInCredential>;
  refresh(args: SignInRegistration & { refreshToken: string }): Promise<{
    accessToken: string;
    expiresAt?: number;
    refreshToken?: string;
    scope?: string;
  }>;
};

/** Only deliberately safe messages from the broker or an adapter reach HTTP. */
export class SignInBrokerError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "SignInBrokerError";
  }
}
