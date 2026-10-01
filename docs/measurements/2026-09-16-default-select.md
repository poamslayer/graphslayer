# What the default field selection saves

Measured on the shipped v1.0 index for #24. Payloads are modelled from the CSDL types rather
than captured from a tenant: field counts and names are exact, values are representative of
their declared type. The percentages are the point, and they do not move much with the values.

## The rule

Nine entity types carry a curated `defaultSelect`, reaching 320 of the 11,546 paths through
`entityType`. A collection read that passes no `select` sends those fields. A single-object
`get` never does, an explicit `select` always wins, and `select: ["*"]` sends none at all.

## Where the saving actually is

Graph narrows `GET /users` to 11 fields on its own. It does not do that for the other
directory collections: they come back as the whole object. That is where the cost is, and it
is most of the win.

| Collection | Full object | Default | Full | Default | Saved |
|---|---:|---:|---:|---:|---:|
| `/groups` | 81 | 9 | 223,311 | 26,611 | **88%** |
| `/applications` | 53 | 6 | 154,711 | 20,811 | **87%** |
| `/servicePrincipals` | 56 | 7 | 172,411 | 25,811 | **85%** |
| `/domains` | 19 | 4 | 52,211 | 11,811 | 77% |
| `/devices` | 37 | 10 | 116,111 | 31,911 | 73% |
| `/subscribedSkus` | 11 | 5 | 33,511 | 17,211 | 49% |

Bytes for a page of 100. Across those six, 752,266 bytes to 134,166: about **188,000 tokens
down to about 33,500, or 82%**.

## `/users` is the weak case, not the strong one

| Shape | Fields | Bytes | ≈ tokens |
|---|---:|---:|---:|
| Graph's own default projection | 11 | 38,979 | 9,745 |
| The curated default | 8 | 33,079 | 8,270 |

**15%.** The ticket's estimate that an unshaped page of a hundred users costs about ten
thousand tokens is close to exact, but Graph is already doing most of the shaping there, so
there is only 15% left to take. It is worth saying plainly that the resource the ticket named
is the one this helps least.

## What "derive it from the type" would have cost

`microsoft.graph.user` has 138 properties, 81 of them scalar. Selecting every scalar property
is **7.4 times wider than the 11 fields Graph returns**, so the derived rule makes the response
larger rather than smaller. It also selects `signInActivity`, which requires
`AuditLog.Read.All`; asking for it without that scope fails the whole call rather than omitting
the field. ADR-0011 records this as the reason the rule is curated.

## Index cost

The nine `defaultSelect` arrays add under 1 kB to a 3.6 MB index, against a 32 MB limit. Cost
was never the constraint here; correctness was.
