// The ways in: each sign-in provider sends the browser away to sign in and, on its return,
// says who the person is and who their network is. provider.ts does the rest the same for all.

export type ProviderId = 'github' | 'google' | 'microsoft' | 'discord' | 'linkedin';

/** Who signed in, as the provider says. Ids are hashed by the caller before they are kept. */
export interface Person {
  provider: ProviderId;
  /** Stable id at the provider: GitHub's numeric id, an OpenID `sub`, a Discord id. */
  id: string;
  /** The short name shown by default: a username, or a first name where there are none. */
  login: string;
  /** The full display name, raw (cleaned by the caller). */
  name: string | null;
  /** Ids, at the same provider, of people followed mutually. */
  mutualIds: string[];
  /**
   * Networks that are not follow graphs, as `kind:value` (`google-hd:example.com`,
   * `entra-tid:<uuid>`, `discord-guild:<id>`). Hashed by the caller with its key.
   */
  networks: string[];
  /** Everyone may see this person's name and read their prayers (LinkedIn). */
  public: boolean;
  /** When the account was made, if the provider says, for the age check. */
  createdAt?: Date;
}

export interface IdentityProvider {
  readonly id: ProviderId;
  /** As written on the button: "Continue with …". */
  readonly label: string;
  /** Where to send the browser to sign in. `state` comes back on the callback unchanged. */
  authorizeUrl(state: string, redirectUri: string): string;
  /** The callback's query, once `state` has been checked: who signed in. Throws on failure. */
  callback(query: Record<string, unknown>, state: string, redirectUri: string): Promise<Person>;
}

/** When a Discord account was made: its id is a snowflake that starts with the time. */
export function snowflakeTime(id: string): Date | undefined {
  if (!/^\d{1,20}$/.test(id)) return undefined;
  return new Date(Number((BigInt(id) >> 22n) + 1420070400000n));
}
