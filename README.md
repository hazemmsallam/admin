# Ticketing Admin

A small web console for administering the [event-ticketing](https://github.com/hazemmsallam/event-ticketing)
system. It is a **pure client** of the ticketing REST API (no database of its own) with a simple
**username/password** login, and provides full CRUD over organizers, halls, events, pricing and
event status.

Built with Spring Boot 3 / Java 21, Thymeleaf, and Spring Security.

---

## What it does

| Area | Actions |
|------|---------|
| **Organizers** | list · create · edit · delete |
| **Halls** | list · create (seated layout with VIP/Premium row ranges, or general admission) · view seats · edit name/address · delete |
| **Events** | list · create · edit · set pricing (per seat type or general admission) · change status (Draft/Published/Cancelled/Sold out) · delete |

Everything is performed by calling the event-ticketing API; the admin app adds the login layer
and the screens.

## Security

A single admin login, configured in `application.yml` (or via env vars):

```yaml
admin:
  username: ${ADMIN_USERNAME:admin}
  password: ${ADMIN_PASSWORD:admin123}
```

Spring Security serves a form login; every page requires authentication. The password is stored
only in config and BCrypt-hashed in memory at startup. **Change the defaults before deploying.**

## Configuration

| Property | Default | Meaning |
|----------|---------|---------|
| `server.port` | `8091` | Port the console runs on. |
| `ticketing.base-url` | `http://localhost:8090` | Base URL of the event-ticketing API. |
| `admin.username` / `admin.password` | `admin` / `admin123` | The console login. |

Set `TICKETING_BASE_URL` to wherever event-ticketing is reachable:
- event-ticketing running in Docker → `http://localhost:8090`
- event-ticketing running on the host/STS → `http://localhost:8089`

## Running it

Prerequisites: JDK 21, Maven, and a **running event-ticketing instance**.

```bash
# point at your ticketing API if it isn't on the default
export TICKETING_BASE_URL=http://localhost:8090
mvn spring-boot:run
```

Then open **http://localhost:8091**, sign in with `admin` / `admin123`, and manage the catalog.

> Tip: start the ticketing side with its demo data (`SEED_DEMO_DATA=true`) so there's something
> to edit immediately.

## How it connects

```
Browser ── login ──> Admin console (Spring Security)
                         │  RestClient
                         ▼
                 event-ticketing REST API ── MySQL
```

The console holds no domain data itself; it reads and writes everything through the ticketing
API and surfaces API validation errors (e.g. "endAt must be after startAt", or a 409 when
deleting a hall still used by events) directly in the UI.
