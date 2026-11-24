FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS website

COPY ./player /app

# busybox gzip, already in the base image. The plain file is deliberately not
# kept: busybox httpd serves index.html.gz to any client that accepts gzip,
# which every browser does.
RUN find /app -name '*.html' -exec gzip -9 {} +

# Compile scratch image
FROM scratch AS compile
LABEL org.opencontainers.image.source="https://github.com/trexx/docker-acestream-webplayer"

COPY --from=website /app /
