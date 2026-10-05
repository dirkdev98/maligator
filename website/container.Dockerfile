FROM debian:bookworm-slim
COPY maligator-site /usr/local/bin/maligator-site
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/maligator-site"]
