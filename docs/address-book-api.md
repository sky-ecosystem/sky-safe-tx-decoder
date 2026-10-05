# Remote address book contract

A deployment can serve address labels to the decoder from a service on the same origin as the decoder page. This is the contract that service implements. The decoder is the client.

## Configuration

On load over `http` or `https` the decoder requests `GET /sky-safe-config.json` from its own origin. It does not request it when opened from a file.

| Response | Effect |
| --- | --- |
| 200 with `{ "remoteAddressBookUrl": "/api/v1/addresses", "addressBookPageUrl": "/" }` | Labels load from the first URL. The second, optional, is the page a person opens to view or manage the book; the decoder shows it as a link |
| 404 | No labels, no message |
| Anything else | Error state: red banner, no labels |

Both URLs must be on the same origin as the page. A cross-origin `remoteAddressBookUrl` is refused before any request. A cross-origin `addressBookPageUrl` is dropped and no link is shown; it never affects the labels.

A host that answers unknown paths with the app page (SPA fallback) must still answer 404 for `/sky-safe-config.json`, or the tool shows the error state.

## List endpoint

`GET <remoteAddressBookUrl>?network=<ethereum|base|sepolia>`

```json
{
  "source": { "name": "example-address-book", "generated_at": "2026-09-17T10:00:00Z" },
  "entries": [
    { "address": "0xdC035D45d973E3EC169d2276DDab16f1e407384F", "label": "USDS token",
      "networks": ["ethereum"], "status": "active", "last_verified": "2026-09-01" }
  ]
}
```

| Field | Rule |
| --- | --- |
| `source.name` | Shown as the source name |
| `entries[].address` | `0x` and 40 hex characters. Matched case-insensitively |
| `entries[].label` | Not empty |
| `entries[].networks` | Network names, or `["all"]` |
| `entries[].status` | `active` or `inactive`. Inactive entries must be included; the decoder warns on them |
| `entries[].last_verified` | `YYYY-MM-DD` |

Extra fields are ignored. A row that fails a rule is skipped and counted; the rest of the list loads.

Both responses need `Content-Type: application/json` and should carry `Cache-Control: no-store`.

## Client behaviour

- The request is sent with same-origin credentials only, so an authenticating proxy in front of the origin works without any token in the tool.
- Nothing is cached or written to browser storage. Each session fetches the book again.
- Any failure clears every remote label, shows a red banner naming the cause, and treats every address as unknown until a manual retry.
- A CSV address book loaded alongside is merged by address. The service wins; a differing label or status is shown as a conflict on the address.
