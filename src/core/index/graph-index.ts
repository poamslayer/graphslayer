export type GraphApiVersion = "v1.0" | "beta";

export interface TypeEntry {
  /** Property name to its CSDL type, flattened through `BaseType`. */
  properties: Record<string, string>;
  /**
   * The fields a collection read sends as `$select` when the caller asked for none. Present on
   * the nine curated directory types and absent everywhere else, and absence means the read is
   * left exactly as Graph would answer it. Microsoft publishes nothing that says which
   * properties matter, so unlike `consistency` this is a decision rather than a reading of the
   * description. ADR-0011 records the rule and why a derived one was rejected.
   */
  defaultSelect?: string[];
}

export interface EnumEntry {
  /** Member names in CSDL declaration order. */
  members: string[];
  /** Present only when the CSDL explicitly marks the enum `IsFlags="true"`. */
  isFlags?: true;
}

export interface ScopeFamily {
  /** Scopes the reference marks as least privileged. Absent when it marks none. */
  least?: string[];
  /** Every scope the reference says grants this call. Never empty. */
  all: string[];
  /**
   * Scopes that are not sufficient alone, by the scope that needs them. The reference says
   * `Application.ReadWrite.All` on a token issuance policy also requires `Policy.Read.All`,
   * and telling a person to consent to the first alone leaves the call still failing.
   */
  alsoRequires?: Record<string, string[]>;
}

export interface ScopeSet {
  delegated?: ScopeFamily;
  application?: ScopeFamily;
}

export interface PathEntry {
  /** The methods this path answers, in a fixed order. */
  methods: string[];
  /**
   * True when Microsoft's description marks this path as needing `ConsistencyLevel: eventual`
   * for advanced queries. Absent means the description carries no marker, which is not the
   * same as the header being unnecessary — the documentation has unmarked cases that need it.
   * A consumer should fall back to its own rule rather than read absence as false.
   */
  consistency?: true;
  /** The entity type the GET returns. Always a key into `types`. Absent when the path returns none. */
  entityType?: string;
  /** Scopes by method, for the methods Microsoft's permissions reference covers. Absent means unknown, never "none needed". */
  scopes?: Record<string, ScopeSet>;
}

export interface GraphIndex {
  version: GraphApiVersion;
  builtAt: string;
  types: Record<string, TypeEntry>;
  enums: Record<string, EnumEntry>;
  paths: Record<string, PathEntry>;
}
