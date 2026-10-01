# Tenant is a required argument on every call, not an active connection

Every tool that touches Graph takes a tenant argument (an alias or tenant id) and resolves it to a connection for that call. There is no "active" or "current" connection that a tool switches. This makes each call auditable on its own, removes the failure where the model switches tenants and then acts on the wrong one, and lets one agent turn touch two tenants on purpose. Lokka v2 uses a switchable active connection; we rejected that model.
