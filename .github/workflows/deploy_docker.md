---
description: Build and deploy the Discogenius Docker image for testing
---

# Build and Deploy Docker Image

Follow these steps to build and deploy the latest version of Discogenius using Docker. This is required whenever changes are made to the UI or backend services to ensure they are correctly packaged.

Use Yarn for local package management and builds; use Docker to validate the packaged application that users will actually run.

For public image-based deployment, use `docker-compose.example.yml` instead of the local build-based `docker-compose.yml`. The release image is published by `.github/workflows/release-dockerhub.yml`.

## 1. Clean Up (Optional but Recommended)

If you are troubleshooting issues or ensuring a completely fresh build (e.g., after theme changes), remove the existing container and image.

```bash
# Stop and remove containers
docker compose down

# Remove the image to force a rebuild
docker rmi discogenius || true
```

## 2. Build the Image

Run the following command in the root of the repository to build the Docker image. This process uses a multi-stage build to compile the frontend and backend.

```bash
docker compose up --build -d
```

## 3. Run the Container

If you built with `docker compose up --build -d`, the container is already running. Otherwise start it with Docker Compose so volumes and environment variables match `docker-compose.yml`.

```bash
docker compose up -d
```

## 3b. Run the Published Image

For the production-style path, use the example compose file as the starting point and pin the image tag you want to run.

Before first run, create your local environment file from the template and adjust values (including `PORT`) as needed:

```bash
cp .env.example .env
```

```bash
docker compose -f docker-compose.example.yml up -d
```

The default published image target is:

```bash
rhjanssen/discogenius:latest
```

Before stable release, prefer pinning a specific alpha tag in the compose file instead of relying on `latest`.

## 4. Verify Deployment

1.  Check the logs to ensure the service started correctly:
    ```bash
    docker logs -f discogenius
    ```
2.  Open your browser to `http://localhost:3737` (default), or use your configured `PORT` value from `.env`.
3.  Verify the UI changes or backend functionality you were testing.

> [!IMPORTANT]
> **UI Testing:** Since the frontend is built into the Docker image, changes to `app/src/` require a full rebuild (Step 2). Hot reloading is available in local dev via `yarn dev`.
