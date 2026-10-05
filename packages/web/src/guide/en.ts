import type { GuideContent } from './types.ts';

export const guide: GuideContent = {
  intro:
    "TorexPloy is a deployment platform on your own server: apps from Git or Docker images, databases, a file store, domains and HTTPS, backups — all in one panel. This guide takes you from start to finish: what to do, where, and in which order.",
  quickStart: [
    { title: "Install on a server", text: "One command installs Docker, the proxy and the panel; the first visit creates the administrator account.", to: "/guide/install" },
    { title: "Connect Git", text: "In Settings → Git a GitHub App is created in one click: repositories, deploy on push, PR previews.", to: "/settings/git" },
    { title: "Create a project and an app", text: "Inside the project, “Create → Application”: pick the repository, TorexBuilder works out the rest.", to: "/projects" },
    { title: "Give it a domain", text: "The automatic address works right away; point your domain’s A record at the server and HTTPS comes by itself.", to: "/guide/domains" },
  ],
  chapters: [
    {
      id: "start",
      title: "Getting started",
      sections: [
        {
          id: "install",
          icon: "download",
          title: "Installation",
          summary: "You need a 64-bit Linux server (Ubuntu 22.04+ / Debian 12+), at least 2 GB of RAM, open ports 80 and 443, and root access.",
          blocks: [
            { type: "code", label: "On the server, as root (one command)", text: "curl -fsSL https://raw.githubusercontent.com/To-Rex/TorexPloy/main/deploy/install.sh \\\n  | sudo TORXPLOY_SOURCE=https://github.com/To-Rex/TorexPloy.git TORXPLOY_PORT=2003 sh" },
            {
              type: "table",
              head: ["Variable", "Meaning"],
              rows: [
                ["`TORXPLOY_SOURCE`", "The repository to build from (`https://github.com/To-Rex/TorexPloy.git`). The panel then follows it for updates."],
                ["`TORXPLOY_PORT`", "The panel port until a domain is set up. Default `3000`; `2003` in the example; `0` opens no port at all."],
                ["`TORXPLOY_REF`", "The branch or tag to build (default `main`)."],
                ["`TORXPLOY_IMAGE`", "A prebuilt image instead of building on the server (`ghcr.io/to-rex/torexploy:main`) — faster, lighter."],
              ],
            },
            {
              type: "steps",
              items: [
                { title: "The script does everything", text: "Installs Docker (if missing), clones the repository and builds the panel image, starts the `ploy-control` container and the Caddy proxy. Usually 3–6 minutes." },
                { title: "Open the panel", text: "`http://<server-ip>:2003` — the port you gave in `TORXPLOY_PORT` (`3000` without it). The first visit creates the administrator." },
                { title: "Panel domain", text: "In [Settings → Web server](/settings/platform) enter a domain such as `deploy.example.uz` (its A record must point at the server). The panel then opens over HTTPS." },
                { title: "Apps domain (optional)", text: "Add a wildcard domain (`*.apps.example.uz`) and every new app gets a neat address. Otherwise an `sslip.io` address based on the server IP is used." },
              ],
            },
            { type: "tip", tone: "info", title: "Another way, and closing the port", text: "You can also clone the repository yourself: `git clone https://github.com/To-Rex/TorexPloy.git && cd TorexPloy && sudo sh deploy/install.sh`. Once the domain is set up, close the port by running the same install command with `TORXPLOY_PORT=0` and `sh -s update` at the end." },
          ],
        },
        {
          id: "concepts",
          icon: "compass",
          title: "Core concepts",
          summary: "Team → Project → Application / Database / File store. Everything fits into this chain.",
          blocks: [
            {
              type: "table",
              head: ["Concept", "What it is", "Where"],
              rows: [
                ["Team", "People and their roles; each team has its own projects. Switched at the top of the sidebar.", "[Settings → Team](/settings/team)"],
                ["Project", "Every part of one product: apps, databases, a file store and shared variables. Services of a project share a network and find each other by name.", "[Projects](/projects)"],
                ["Application", "A service from a Git repository or a Docker image: web (listens on a port) or a background worker.", "Project → Create → Application"],
                ["Database", "PostgreSQL, MySQL, MariaDB, MongoDB, Redis, RabbitMQ, ClickHouse, MinIO — one click, with backups.", "Project → Create → Database"],
                ["File store", "S3-compatible storage (SeaweedFS): buckets, keys, public links, a place for backups.", "Project → Create → File store"],
                ["Deployment", "Building and starting one version of an app. Each is numbered (#1, #2…), keeps its log and can be rolled back to.", "Application → Deployments"],
                ["Server", "The machine with the panel (`main`) and extra servers over SSH. You pick the server for every app and database.", "[Servers](/servers)"],
              ],
            },
          ],
        },
        {
          id: "navigation",
          icon: "layout",
          title: "Finding your way around",
          summary: "The sidebar, the ⌘K command palette, live updates, the server clock and language/theme — in a minute.",
          blocks: [
            {
              type: "list",
              items: [
                "**Sidebar** — the Home group (Projects, Deployments, Monitoring, Scheduled tasks, Docker, Proxy) and Settings. The bottom button collapses it into an icon rail.",
                "**Search (⌘K / Ctrl+K)** — jump to any page, project, app or database, switch language and theme.",
                "The **Live** indicator — the panel stays connected to the server: statuses, logs and metrics change without reloading.",
                "**Server clock** — the clock at the top runs in the server’s time zone; click it to change the zone (administrator).",
                "**Profile menu** (bottom left) — language (Uzbek, Russian, English), theme (light, dark, system), sign out.",
              ],
            },
          ],
        },
      ],
    },
    {
      id: "apps",
      title: "Applications",
      sections: [
        {
          id: "apps-create",
          icon: "rocket",
          title: "Creating an application",
          summary: "Three sources: a GitHub repository, any Git URL, or a ready Docker image.",
          to: "/projects",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Open the project → Create → Application", text: "Name, kind (web or background worker) and server." },
                { title: "Pick the source", text: "**GitHub** — repository and branch from a list through the connected GitHub App, deploy on push. **Git** — any URL (a deploy key is issued; add it to the repository). **Docker** — an image such as `nginx:1.27` or `ghcr.io/team/app:latest`; private registry logins live in Settings → Registries." },
                { title: "Create", text: "The first deployment starts right away. The app page shows the process stage by stage." },
              ],
            },
            { type: "tip", tone: "info", text: "A web app listens on a port and gets a domain; a worker runs without a port — for queue consumers, bots, cron." },
          ],
        },
        {
          id: "build",
          icon: "hammer",
          title: "Build methods",
          summary: "TorexBuilder detects the project by itself; when needed, pick a Dockerfile, Nixpacks, Railpack, Heroku/Paketo buildpacks or a static site.",
          blocks: [
            {
              type: "table",
              head: ["Method", "When to pick it"],
              rows: [
                ["TorexBuilder (default)", "Detects Node, Python, Go, PHP, Ruby, Java, .NET, Rust, static sites and more; builds with caching and a non-root container. Fine-tuned through `torexploy.json`."],
                ["Dockerfile", "When the repository has its own Dockerfile; a path and a `--target` stage can be set."],
                ["Nixpacks / Railpack", "When you want Railway-style automatic builds."],
                ["Heroku / Paketo buildpacks", "For projects used to Heroku or Cloud Native Buildpacks."],
                ["Static", "HTML/CSS/JS or an SPA: a build command and an output folder, served by a lightweight web server."],
              ],
            },
            { type: "p", text: "In Application → General → the **Build** card you set the method, root folder, install/build/start commands and system packages. **Show plan** reveals what was detected, with warnings, before building." },
          ],
        },
        {
          id: "deploy",
          icon: "play",
          title: "The deployment process",
          summary: "Code → Build → Start → Health → Traffic → Finish. The previous version keeps serving until the new one is healthy.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Code", text: "The repository is cloned or the image pulled." },
                { title: "Build", text: "The image is built with the chosen method; the log streams live." },
                { title: "Start", text: "New containers come up on the project network with their variables and links." },
                { title: "Health", text: "Waits for the health check path (e.g. `/healthz`) to answer; the timeout is in the Advanced tab." },
                { title: "Traffic", text: "The proxy switches to the new container — users notice nothing." },
                { title: "Finish", text: "Old containers stop; the version is marked active." },
              ],
            },
            { type: "tip", tone: "info", title: "Strategies", text: "**Rolling** (default) — zero-downtime replacement. **Recreate** — the old one stops first, then the new one starts; for apps that cannot share one volume between two copies. The replica count is in the Advanced tab too." },
          ],
        },
        {
          id: "history",
          icon: "history",
          title: "History, rollback and clean-up",
          summary: "Every deployment keeps its number, status, duration and log; rolling back to an older version is one click.",
          blocks: [
            {
              type: "list",
              items: [
                "**#N** — the number within the app; it never changes after a clean-up. The card shows who started it, branch and commit, date, **how long it took** (queue wait and build time separately).",
                "**Roll back to this version** — in the `⋯` menu; the image is reused, no build, traffic switches without downtime.",
                "**Redeploy** — bring the active version up again with the same image.",
                "**Delete** — removes a finished, non-active deployment with its log and image.",
                "**Clean up** — removes old deployments in one click; the **active** and the **newest** are always kept.",
                "**Image retention** (Settings → Platform) — that many recent images stay on disk; older ones are removed automatically and cannot be rolled back to (“Image removed”).",
              ],
            },
          ],
        },
        {
          id: "env",
          icon: "variable",
          title: "Variables and links",
          summary: "App variables, project-wide shared variables and database links — without copying passwords.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Application → Variables", text: "Write `KEY=value` lines in the editor or paste a `.env` file. Secrets are stored hidden." },
                { title: "Link a database", text: "On the same tab, **Add link**: a database and a prefix (`DB_`). The app receives `${DB_DATABASE_URL}`, `${DB_PGHOST}`, `${DB_PGPASSWORD}` and so on — if the password changes, the link follows." },
                { title: "Shared variables", text: "**Shared variables** on the project page go to every app; an app’s own value wins." },
              ],
            },
            { type: "tip", tone: "work", title: "Note", text: "Variables take effect **on the next deployment** — a “Deploy now” reminder appears at the top of the page." },
          ],
        },
        {
          id: "domains",
          icon: "globe",
          title: "Domains and HTTPS",
          summary: "Every web app gets an automatic address; your own domain needs one A record — the certificate is issued and renewed by itself.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "DNS", text: "At your domain provider, point the `A` record at the server IP (and `www` if you want it)." },
                { title: "Application → Domains → Add domain", text: "The domain, optionally a path (`/api`) and a port. HTTPS is on by default." },
                { title: "Wait", text: "Once DNS has propagated the panel shows it (DNS status) and Caddy obtains a Let’s Encrypt certificate — usually within a minute." },
              ],
            },
            { type: "list", items: ["**Redirect** — a 301 such as `www.example.uz` → `example.uz` is set on a domain.", "Domains can also be given to **databases and the file store** (handy for an S3 endpoint).", "The [Proxy](/proxy) page shows which container each domain goes to and the Caddy configuration."] },
          ],
        },
        {
          id: "logs",
          icon: "scroll",
          title: "Logs and terminal",
          summary: "Live logs with level colouring; search, copy, download, full screen. The terminal gets you inside the container.",
          blocks: [
            {
              type: "list",
              items: [
                "**Application → Logs** — container logs stream live; `error`/`warn`/`info` levels are distinguished, with a filter and “follow the tail”. Timestamps use the server’s time zone.",
                "Top-right buttons: **pause**, **show time**, **wrap lines**, **copy**, **download**, **full screen**.",
                "**Deployment log** — each deployment’s own log (build, start, health), via “Open log”.",
                "**Terminal** — Application → General → Terminal (or the `⋯` menu): `sh`/`bash` inside the container. Databases have one too.",
              ],
            },
          ],
        },
        {
          id: "monitoring",
          icon: "activity",
          title: "Monitoring",
          summary: "CPU, memory and network charts for every app and database; an overview per server.",
          to: "/monitoring",
          blocks: [
            { type: "list", items: ["**Application → Monitoring** — resources over the last hour/day, restart count, replica state.", "The [Monitoring](/monitoring) page — servers and all services in one place; heavy apps stand out.", "Memory and CPU limits are set in the Advanced tab; a container that exceeds them restarts, and that arrives as a [notification](/settings/notifications)."] },
          ],
        },
        {
          id: "cron",
          icon: "clock",
          title: "Cron jobs",
          summary: "Scheduled commands inside an app: reports, clean-ups, imports. Times follow the server’s zone.",
          to: "/schedules",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Application → Cron jobs → Add", text: "A name, a cron expression (`0 3 * * *` — every day at 03:00) and a command (`node scripts/report.js`)." },
                { title: "Runs", text: "The job runs in a separate container on the app’s current image with its variables; “Run now” starts it by hand." },
                { title: "Results", text: "Each run keeps its log and status; the [Scheduled tasks](/schedules) page lists every job in the team." },
              ],
            },
          ],
        },
        {
          id: "previews",
          icon: "git",
          title: "PR previews",
          summary: "Every pull request runs at its own address with a comment linking to it; it is removed when the PR closes.",
          blocks: [
            { type: "p", text: "Enabled on the app’s **PR previews** tab (for apps connected through the GitHub App). Opening a PR creates and deploys a preview app, every push updates it, closing removes it. A preview can have its own variables (a test database, say)." },
            { type: "tip", tone: "info", text: "If the GitHub App is older, enable the **Pull requests: Read and write** permission and the **Pull request** event in its settings." },
          ],
        },
        {
          id: "compose",
          icon: "layers",
          title: "Docker Compose stacks",
          summary: "Run a ready `docker-compose.yml` of several services — from a repository or pasted by hand.",
          blocks: [
            { type: "p", text: "Project → Create → **Docker Compose**: the file comes from a repository (by path) or is pasted as text. The platform joins the services to the project network, passes `TZ`, lets you attach a domain to the web service; logs and status show per service." },
          ],
        },
      ],
    },
    {
      id: "data",
      title: "Data",
      sections: [
        {
          id: "services",
          icon: "database",
          title: "Databases",
          summary: "PostgreSQL, MySQL, MariaDB, MongoDB, Redis, RabbitMQ, MinIO, ClickHouse — pick a version, one click.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Project → Create → Database", text: "Type, version, name and server. Credentials are generated; if you prefer, switch on **“Choose the credentials myself”** and set the user, database name, password (and the root password for MySQL/MariaDB)." },
                { title: "Connecting", text: "The General tab shows the **Internal address** (`<name>:5432`, inside the project only) and **Credentials** (viewing is recorded in the audit log). Linking to an app happens on the app’s Variables tab." },
                { title: "External access (optional)", text: "Advanced → **Public port**: that server port is opened to the database; the full URL appears under “External address”. Only when needed, and with a firewall." },
              ],
            },
            { type: "tip", tone: "work", text: "Connect from an app through the **internal address** (the database’s name), not `localhost` — they are separate containers on one network." },
          ],
        },
        {
          id: "backups",
          icon: "archive",
          title: "Backups",
          summary: "By hand or on a schedule; on the server, in S3 or in your own file store; restore in one click.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Database → Backups → Create backup", text: "For PostgreSQL, MySQL, MariaDB, MongoDB and Redis. The backup appears with its size and time; it can be **downloaded** or **restored** (Redis: download only)." },
                { title: "Schedule", text: "A cron expression (in the server’s zone) and how many to keep (1–365): older ones are removed by themselves." },
                { title: "External destination", text: "In [Settings → S3 destinations](/settings/storage) add AWS S3, Cloudflare R2, MinIO… or pick the project’s **File store** — every backup is sent there as well." },
              ],
            },
            { type: "tip", tone: "bad", title: "Restoring", text: "A restore replaces the database’s current data with the backup’s state. Take a fresh backup first." },
          ],
        },
        {
          id: "filestore",
          icon: "hard-drive",
          title: "File store (S3)",
          summary: "S3-compatible storage for images, documents and backups — works with the AWS SDK, rclone, s3cmd.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Project → Create → File store", text: "SeaweedFS comes up in one click; the General tab shows the endpoint and root keys." },
                { title: "Buckets and keys", text: "On the **Files** tab create a bucket, upload files, get a public link. On the **Keys** tab issue a separate access key per app (limited to the buckets it needs)." },
                { title: "Linking to an app", text: "Variables → Add link: the app receives `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `AWS_*`. External apps, SDK samples (Node, Python, PHP, Go, Java, .NET, Ruby, Django, CLI) and temporary links are on the store’s **Docs** tab, filled in for that very store." },
                { title: "Domain", text: "On the **Domains** tab give it an address such as `files.example.uz` — files are served directly over HTTPS." },
              ],
            },
          ],
        },
        {
          id: "templates",
          icon: "grid",
          title: "Templates",
          summary: "130+ ready apps (n8n, WordPress, Nextcloud, Gitea, Grafana, Open WebUI…) — with the database, storage and settings they need, in one click.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Project → Create → From a template", text: "Browse by category or search; the card says which database it needs and the approximate memory." },
                { title: "Name, server, domain", text: "The right side lists what gets created. Leave the domain blank for an automatic address." },
                { title: "First sign-in", text: "After installing, the General tab shows a **First sign-in** card: where the login and password are (Variables, the log or a setup page)." },
              ],
            },
            { type: "tip", tone: "info", text: "An app from a template is an ordinary app: variables, domain, database, backups — all editable." },
          ],
        },
      ],
    },
    {
      id: "team",
      title: "Team and security",
      sections: [
        {
          id: "roles",
          icon: "users",
          title: "Team and roles",
          summary: "Invite members with a link; give everyone the level of access they need.",
          to: "/settings/team",
          blocks: [
            {
              type: "table",
              head: ["Role", "What they can do"],
              rows: [
                ["Viewer", "Sees everything (logs, metrics, history) but changes nothing."],
                ["Developer", "Creates apps and databases, deploys, manages variables and domains, takes backups."],
                ["Admin", "Additionally: registries, S3 destinations, notifications, servers, Docker and Proxy, deleting services."],
                ["Owner", "The team’s owner: members and roles, deleting the team."],
                ["Instance administrator", "Platform settings (domain, time zone, image retention), updates."],
              ],
            },
            { type: "p", text: "**Inviting**: Settings → Team → Invite → copy the link and send it (it can be copied again from the pending invitations list). One person can be in several teams — switch at the top of the sidebar." },
          ],
        },
        {
          id: "security",
          icon: "shield",
          title: "Security",
          summary: "Two-factor authentication, API tokens, the deploy hook, the audit log.",
          to: "/settings/security",
          blocks: [
            {
              type: "list",
              items: [
                "**2FA** — Settings → Security: an authenticator app (TOTP) and backup codes.",
                "**API tokens** — [Settings → API tokens](/settings/tokens): for CI and scripts; each token belongs to a team and can expire.",
                "**Deploy hook** — at the bottom of Application → Deployments: a secret URL; a `POST` to it starts a deployment (from GitLab CI, say). The link can be rotated at any time.",
                "**Audit log** — [who did what, and when](/settings/audit): sign-ins, changes, password views.",
                "Every secret (passwords, tokens, GitHub keys) is stored encrypted on the server (`PLOY_SECRET_KEY`).",
              ],
            },
          ],
        },
        {
          id: "notifications",
          icon: "bell",
          title: "Notifications",
          summary: "Telegram, Discord, Slack or a signed webhook — about failed deployments, crashing apps, backup errors, servers going offline.",
          to: "/settings/notifications",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Add a channel", text: "The kind (Telegram bot token and chat ID; a Discord/Slack webhook URL; your own webhook) and the message language." },
                { title: "Events", text: "Which events to send: deployment succeeded/failed, app crashed (crash loop), backup failed, server offline." },
                { title: "Test", text: "“Save and test” sends a test message; the last delivery status shows in the list." },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "platform",
      title: "Platform",
      sections: [
        {
          id: "servers",
          icon: "server",
          title: "Servers",
          summary: "Besides the `main` server with the panel, connect other servers over SSH; apps and databases run on any of them.",
          to: "/servers",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Servers → Add server", text: "A name, `user@host`, port and SSH key. The platform connects, checks Docker (installs it if needed) and brings up the proxy." },
                { title: "Verification", text: "Once the status is **Ready**, the server can be picked when creating an app. On a problem, “Verify again” shows the reason." },
                { title: "Public IP", text: "Detected automatically; public ports and DNS checks rely on it. If it was not detected — “Verify again”." },
              ],
            },
            { type: "p", text: "The [Docker](/docker) page lists the server’s containers, images and volumes; the [Proxy](/proxy) page shows routes and Caddy’s state (administrators)." },
          ],
        },
        {
          id: "settings",
          icon: "settings",
          title: "Platform settings",
          summary: "Panel domain, apps domain, time zone, image retention, registries and S3 destinations.",
          to: "/settings/platform",
          blocks: [
            {
              type: "list",
              items: [
                "**Web server** — the panel domain (HTTPS), the wildcard domain for apps, proxy status.",
                "**Time zone** — one IANA zone for the whole instance: dates in the panel, cron and backup schedules, the containers’ `TZ` variable. Also changeable from the clock at the top.",
                "**Image retention** — how many recent images to keep per app (for rollbacks).",
                "**Registries** — Docker Hub, GHCR and private registry logins: for pulling private images.",
                "**S3 destinations** — external storage that receives backups.",
                "**Git** — the GitHub App: created in one click, webhook and permissions set up automatically.",
              ],
            },
          ],
        },
        {
          id: "updates",
          icon: "refresh",
          title: "Updating",
          summary: "The panel updates itself: when a new version is out, a button appears in the sidebar; apps and databases keep running.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Notice", text: "Every 6 hours (`PLOY_UPDATE_INTERVAL_SEC`, at least 600) the tracked branch is checked; on a new commit the sidebar shows **Update available** and Settings → Web server lists the changes." },
                { title: "Update", text: "An instance administrator presses the button: a temporary `ploy-updater` container prepares the new image, recreates the panel with the same ports and volumes, and checks its health." },
                { title: "If it fails", text: "The old version comes back automatically and the reason shows in the status. By hand — the install command in `update` mode:" },
                { title: "Manual update command", text: "`curl -fsSL https://raw.githubusercontent.com/To-Rex/TorexPloy/main/deploy/install.sh | sudo TORXPLOY_SOURCE=https://github.com/To-Rex/TorexPloy.git sh -s update`" },
              ],
            },
          ],
        },
        {
          id: "troubleshooting",
          icon: "wrench",
          title: "Troubleshooting",
          summary: "The most common situations and their simple fixes.",
          blocks: [
            {
              type: "faq",
              items: [
                { q: "Installing: “port 80 is already used by another container”", a: "Another web server (nginx, apache, traefik) or an old proxy holds port 80. Stop it (`docker ps`, `sudo ss -ltnp | grep :80`) and run the script again — Caddy manages 80/443 itself." },
                { q: "The app cannot reach the database (timeout, connection refused)", a: "Use the **internal address** — the database’s name and port (`postgres:5432`), not `localhost` or the public IP. Easiest: **link** the database to the app and use `${DB_DATABASE_URL}`. The database and the app must be in the same project." },
                { q: "The build failed", a: "Open the deployment log — it shows the stage where it stopped. Usually: a wrong root folder, a missing start command, the Node/Python version. In General → Build set the method and commands explicitly or use a Dockerfile; **Show plan** reveals what was detected." },
                { q: "The domain does not open, or there is no certificate", a: "Check the DNS status in Application → Domains: the A record does not point at the server IP or has not propagated yet. Ports 80 and 443 must be open. Check the route on the Proxy page." },
                { q: "Cannot roll back (“Image removed”)", a: "Versions beyond the image retention limit are removed from disk. Raise the number in Settings → Platform; the commit can also be deployed again." },
                { q: "The deployment sits in “Queued”", a: "Another deployment of this app is running, or the server is busy. Watch the live process on the Deployments page; cancel it if needed." },
                { q: "“Docker is not reachable”", a: "Docker is stopped on the server: `sudo systemctl status docker`, then `sudo systemctl start docker`. For SSH servers — Servers → Verify again." },
                { q: "The external URL has no host, only `:5432`", a: "The server’s public IP was not detected. Servers → the server → **Verify again**; the full address then appears. Remember to open the port in the firewall." },
              ],
            },
          ],
        },
      ],
    },
  ],
};
