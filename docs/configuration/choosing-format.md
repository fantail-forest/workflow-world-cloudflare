# Choosing a Configuration Format

The Cloudflare builder supports both TOML and JSONC for wrangler configuration files. You can choose your output format independently of your override file format.

## Output format flag

```bash
# Default: generates wrangler.toml
workflow-cloudflare build --name <app-name>

# Explicit TOML
workflow-cloudflare build --name <app-name> --format toml

# JSONC output
workflow-cloudflare build --name <app-name> --format jsonc
```

## Override file format

Your override file can be in either format regardless of the output flag:

- `wrangler.app.toml` - TOML format
- `wrangler.app.jsonc` - JSONC format (supports `//` and `/* */` comments)

You cannot have both. The builder throws an error if both files exist.

## TOML example

```toml title="wrangler.app.toml"
name = "my-workflow-app"

[vars]
APP_ENV = "production"

[[hyperdrive]]
binding = "APP_DB"
id = "abc123"
```

## JSONC example

```jsonc title="wrangler.app.jsonc"
{
  // Application name
  "name": "my-workflow-app",
  "vars": {
    "APP_ENV": "production"
  },
  "hyperdrive": [
    {
      "binding": "APP_DB",
      "id": "abc123"
    }
  ]
}
```

## Resolution order

1. Check for `wrangler.app.toml`
2. Check for `wrangler.app.jsonc`
3. If both exist, throw an error
4. If neither exists, use only the builder defaults

The output format is determined by the `--wrangler-format` flag (default: `toml`), not by the override file format. You can write your overrides in JSONC and still output TOML, or vice versa.
