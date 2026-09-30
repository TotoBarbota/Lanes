FROM eclipse-temurin:21-jdk-alpine
WORKDIR /app
COPY App.java .
RUN javac App.java
CMD ["java", "-cp", "/app", "App"]
