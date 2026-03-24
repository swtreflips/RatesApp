# Claude Project Instructions — Ocean Rate Request App

## Core Product Context

This project is a multi-role ocean rate request platform built as a single React application.

Tech stack:
- React.js frontend
- Vercel deployment
- Supabase for database, auth, and server-side support
- GitHub for version control
- No traditional backend
- Supabase Edge Functions for server-side orchestration such as notifications

The application serves two main user roles:
- Requester
- Provider / Freight Forwarder

This is not two separate apps. It is one shared platform with a shared shell and role-specific feature domains rendered conditionally.

---

## Architecture Philosophy

Build the system as a single platform composed of:

1. Shared shell / platform layer
2. Requester feature domain
3. Provider feature domain

These are separate feature modules inside one codebase, not separate applications.

### Shared shell responsibilities
The shared shell is the common UI and infrastructure layer for all users. It should contain:
- top navigation
- sidebar or app navigation
- shared layout structure
- auth/session loading state
- user profile loading
- role detection
- app-wide styling foundation
- route container
- placeholders for notifications, account menu, and global actions

The shared shell must not contain role-specific business workflows beyond deciding which feature domain to mount.

### Requester responsibilities
The requester side is responsible for:
- creating RFQ batches
- adding and editing lanes
- duplicating lane rows for gateway variants
- managing pending requests
- triggering send/notification flows
- reviewing submitted rates

### Provider responsibilities
The provider side is responsible for:
- viewing eligible pending lanes
- filtering/searching lanes
- submitting rates
- reviewing past submissions
- interacting only with the supply-side workflow

### Shared component philosophy
Shared UI elements should be reusable and parameterized where appropriate:
- lane table
- editable grid
- autocomplete location input
- status badges
- modals
- cards
- batch summary blocks

Avoid duplicating components unless the workflows are materially different.

---

## Data Philosophy

Treat lane requests as the source template and submitted quotes as separate persistent records.

### Conceptual model
- lane requests represent the open demand side
- providers view filtered subsets of open lane requests
- provider submissions create quote/rate records tied to the lane and the provider

### Important
Do not model requester and provider as separate databases or separate applications.
Use shared entities with different views and behaviors.

### Coverage / filtering concept
The system may later support provider-specific coverage filtering, such as:
- some providers do not quote India origins
- some providers only quote certain regions or ports

Design with this in mind, but do not overcomplicate the initial implementation.

---

## Security / Access Philosophy

Do not over-engineer row-level security in the initial phase unless necessary for a specific feature.
The initial product model is a shared portal with role-aware filtered views.

The important mental model is:
- one dataset
- different filtered views
- same underlying system

Keep future security extensibility in mind, but optimize first for architecture clarity and working workflows.

---

## Development Philosophy

Develop in phases.
Do not try to build the entire system in one pass.

The correct implementation strategy is progressive layering:
1. build shared shell
2. refine shell
3. commit shell
4. build requester experience
5. refine requester flow
6. commit requester
7. build provider experience
8. refine provider flow
9. commit provider
10. only then move into orchestration, notifications, and deeper workflow logic

Each phase should produce a coherent, reviewable state.

---

## Workflow Expectations for Claude

When working on this project, always follow these rules:

### 1. Respect the current phase
Only work on the phase explicitly requested.
Do not jump ahead into later feature domains unless asked.

### 2. Prefer structural correctness over premature completeness
It is better to establish the correct shell, routing, and component boundaries first than to rush into business logic.

### 3. Keep role domains separate
Requester and provider workflows should be implemented as separate feature modules within the same app.

### 4. Reuse shared foundations
If a component can be shared cleanly, place it in a shared components area.
If the logic is role-specific, keep it in the corresponding feature module.

### 5. Avoid fake backend patterns
This project uses Supabase and Edge Functions, not a traditional custom backend.
Do not introduce unnecessary backend abstractions unless clearly justified.

### 6. Design for iterative review
Every phase should be implementable, testable, and committable on its own.

### 7. Preserve production-oriented architecture
Prefer maintainability, composability, and clean boundaries over quick hacks.

---

## Project Structure Direction

Use a structure conceptually similar to:

```text
src/
  app/
    App
    Shell
    RoleRouter
    providers/
  features/
    requester/
      pages/
      components/
      hooks/
      services/
    provider/
      pages/
      components/
      hooks/
      services/
  components/
    shared reusable components
  lib/
    supabase client
    utilities
  hooks/
    shared hooks