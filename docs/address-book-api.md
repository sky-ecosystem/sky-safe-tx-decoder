# Address book API

This document states the contract the Safe Transaction Decoder expects from an
address book service. A team that implements this contract can serve labels to
the decoder. The decoder is the client. The service is any HTTP server on the
same origin as the decoder page.

## Deployment configuration

The decoder holds no configuration in its bundle. It reads the address book URL
at run time.

- On startup the decoder sends `GET /sky-safe-config.json` to its own origin.
- The decoder skips the request when the page is opened from a file.
- HTTP 200 with the body below sets the address book URL.
- HTTP 404 means the deployment configured no address book. The decoder loads
  no labels and shows no message.
- Any other status, a body that is not JSON, or a body without a
  `remoteAddressBookUrl` string, puts the decoder in the error state.

Body:

```json
{ "remoteAddressBookUrl": "/api/v1/addresses" }
```

`remoteAddressBookUrl` is a string. A path is recommended. An absolute URL must
be on the same origin as the decoder page.

## List endpoint

- Request: `GET <remoteAddressBookUrl>?network=<network>`.
- `network` is `ethereum`, `base`, or `sepolia`.
- The decoder sets `network` from the Safe it is reviewing. The decoder omits
  `network` on a manual load from the Settings page.
- The service returns every entry that is valid on the requested network.
- The service may return every entry and let the decoder filter. The decoder
  filters on the `networks` field of each entry.

Response body:

```json
{
  "source": { "name": "sff-address-book", "generated_at": "2026-09-17T10:00:00.000Z" },
  "entries": [
    {
      "address": "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
      "label": "USDS token",
      "networks": ["ethereum"],
      "status": "active",
      "last_verified": "2026-09-01"
    }
  ]
}
```

## Fields

| Field | Type | Rule |
| ----- | ---- | ---- |
| `source.name` | string | Shown in the decoder bar as the source name. |
| `source.generated_at` | string | ISO 8601 timestamp. |
| `entries[].address` | string | `0x` and 40 hexadecimal characters. EIP-55 checksummed is recommended. The decoder matches on the lower-case form. |
| `entries[].label` | string | Not empty. |
| `entries[].networks` | array of strings | Network names, or the single value `all`. |
| `entries[].status` | string | `active` or `inactive`. |
| `entries[].last_verified` | string | Date of the last verification. `YYYY-MM-DD` is recommended. |

Extra fields are allowed. The decoder ignores them.

`networks` may contain `all`. An entry with `all` is valid on every network.

The decoder skips a row that fails a rule. The decoder keeps the rest of the
list and reports the number of skipped rows. One bad row does not cost the
signer the whole book.

The decoder keeps the last entry when two entries carry the same address.

## Required headers

- `Content-Type: application/json` on both endpoints. The decoder rejects a
  response whose content type does not contain `application/json`.
- `Cache-Control: no-store` on both endpoints. The decoder also sends
  `cache: 'no-store'` on every request.

## Same-origin requirement

The address book URL must be on the origin of the decoder page.

- The decoder sends the request with `credentials: 'same-origin'`.
- A cross-origin URL therefore receives no cookies. An authenticating proxy
  answers 401 to such a request.
- The decoder refuses a cross-origin URL before it makes the request. The
  message names both origins in full.
- A local development server needs a proxy so the address book path is
  same-origin with the page.

The rule has a second purpose. Labels change what a signer believes about an
address. A label from an origin the deployment did not configure is not
evidence.

## Fail-closed rules on the client

The decoder never shows a stale or partial book.

- A failure clears every remote label. Every address is then shown as unknown.
- A failure shows a red banner. The banner names the cause and states that
  every address is treated as unknown until the book loads.
- The decoder never labels an address from a failed source.
- The decoder keeps no cache and writes nothing to browser storage. Each
  session fetches the book again.
- A retry is a deliberate act by the signer. The decoder does not retry in a
  loop.

The decoder reports these causes:

| Condition | What the signer reads |
| --------- | --------------------- |
| HTTP 401 or 403 | The service refused the request. Sign in, then retry. |
| Other error status | The service returned that status. |
| Content type is not JSON | The URL probably points at a web page or a sign-in screen. |
| Request failed | The service may be down. |
| Body is not the documented envelope | The response shape is unexpected. |

## Inactive entries

An inactive entry stays in the response. The service must not omit it.

The decoder shows an inactive entry as a red `INACTIVE` badge with the label.
The badge is a warning, not a missing label. A signer who sees an inactive
address knows the organisation withdrew it, which is different from an address
the organisation never listed.

## CSV comparison

A signer may load a CSV address book next to the service book. The decoder
merges the two lists by address.

- The service book wins on a collision.
- A different label or a different status is reported as a conflict. The
  decoder shows both labels on the address.
- The decoder does not resolve a conflict. The source of truth is fixed by the
  team that owns the service.
