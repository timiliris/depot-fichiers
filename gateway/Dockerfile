# No external dependencies: nothing to download, so the build is reproducible
# and works even when the module proxy is unreachable.
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /depot-gw .

FROM alpine:3.20
RUN adduser -D -u 1001 depot
COPY --from=build /depot-gw /usr/local/bin/depot-gw
USER 1001
EXPOSE 5100
ENTRYPOINT ["/usr/local/bin/depot-gw"]
