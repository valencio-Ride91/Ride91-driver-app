# Build the Vite admin panel, then serve the static dist with nginx on $PORT.
# VITE_API_URL is baked in at build time (it's a public value, not a secret).
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV VITE_API_URL=https://ride91-api-561130004577.asia-south1.run.app
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Cloud Run sends traffic to $PORT (8080); nginx.conf listens there.
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
