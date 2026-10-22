FROM alpine:3.24@sha256:71e9b7bae160ba167fa17414401b94cbcdaf3c32feeab9298bd794a2a0614c35 AS website

COPY ./player /app

# busybox gzip, already in the base image. The plain file is deliberately not
# kept: busybox httpd serves index.html.gz to any client that accepts gzip,
# which every browser does.
RUN find /app -name '*.html' -exec gzip -9 {} +

# Compile scratch image
FROM scratch AS compile
LABEL org.opencontainers.image.source="https://github.com/trexx/docker-acestream-webplayer"

COPY --from=website /app /
