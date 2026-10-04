/**
 * JVM stacks: Java with Maven or Gradle (Spring Boot, Quarkus and Micronaut
 * get their port flags) and Clojure with Leiningen or tools.deps. The JDK
 * comes from the build files or the usual version files, the build runs in
 * a JDK image with dependency caches, and only the artifact ships in a JRE.
 */
import { join } from 'node:path';
import { addUser, cmd, exists, generated, readText, roundUp, run, runtimePackages, toolVersions, warn, type BuildPlan, type Ctx } from './shared.ts';

/** LTS releases that Temurin images exist for. */
const JDK_RELEASES = [8, 11, 17, 21, 25];
const DEFAULT_JDK = 21;
const JVM_CACHES = ['/root/.m2', '/root/.gradle', '/root/.gitlibs'];

/** JDK release from the config file, `.java-version`, `.sdkmanrc`, `.tool-versions`/`mise.toml`, then the build file. */
export async function jdkRelease(ctx: Ctx, buildFile: string): Promise<number> {
  const dir = ctx.dir;
  const tools = await toolVersions(dir);
  const sdkmanrc = /^java\s*=\s*(\S+)/m.exec((await readText(join(dir, '.sdkmanrc'))) ?? '')?.[1];
  const fromFiles = ctx.runtime.java ?? (await readText(join(dir, '.java-version')))?.trim() ?? sdkmanrc ?? tools.java;
  const fromBuild =
    /<(?:maven\.compiler\.release|java\.version|maven\.compiler\.source|release)>\s*(\d+(?:\.\d+)?)\s*</.exec(buildFile)?.[1] ??
    /JavaLanguageVersion\.of\((\d+)\)|jvmToolchain\((\d+)\)|sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?['"]?(?:1\.)?(\d+)/.exec(buildFile)?.slice(1).find((v) => v !== undefined);
  const text = fromFiles ?? fromBuild ?? '';
  const number = Number(/(?:^|\D)(?:1\.)?(\d{1,2})(?:\D|$)/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(number) || number < 8) return DEFAULT_JDK;
  const release = roundUp(number, JDK_RELEASES);
  if (release !== number) warn(ctx, `JDK ${number} is not an LTS release; building with JDK ${release}.`);
  return release;
}

export async function planJava(ctx: Ctx, tool: 'maven' | 'gradle'): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const buildFile = tool === 'maven' ? ((await readText(join(dir, 'pom.xml'))) ?? '') : ((await readText(join(dir, 'build.gradle.kts'))) ?? (await readText(join(dir, 'build.gradle'))) ?? '');
  const jdk = await jdkRelease(ctx, buildFile);
  const framework = buildFile.includes('spring-boot') ? 'Spring Boot' : buildFile.includes('quarkus') ? 'Quarkus' : buildFile.includes('micronaut') ? 'Micronaut' : null;
  const wrapper = await exists(join(dir, tool === 'maven' ? 'mvnw' : 'gradlew'));
  const build = input.buildCommand ?? (tool === 'maven' ? `${wrapper ? './mvnw' : 'mvn'} -B -q -DskipTests package` : `${wrapper ? './gradlew' : 'gradle'} --no-daemon -q build -x test`);
  const outDir = tool === 'maven' ? 'target' : 'build/libs';
  // Quarkus produces an exploded `quarkus-app/` directory; everything else a single executable jar.
  const collect = framework === 'Quarkus' ? `cp -r ${tool === 'maven' ? 'target' : 'build'}/quarkus-app/. /out/` : `cp $(ls ${outDir}/*.jar | grep -v -e '-plain' -e 'original' | head -n1) /out/app.jar`;
  // None of the frameworks read $PORT on their own: each gets its port setting on the command line.
  const sysProps = framework === 'Quarkus' ? '-Dquarkus.http.port=$PORT ' : framework === 'Micronaut' ? '-Dmicronaut.server.port=$PORT ' : '';
  const start = input.startCommand ?? `java $JAVA_OPTS ${sysProps}-jar /app/${framework === 'Quarkus' ? 'quarkus-run.jar' : 'app.jar'}${framework === 'Spring Boot' ? ' --server.port=$PORT' : ''}`;
  const buildImage = wrapper ? `eclipse-temurin:${jdk}-jdk` : tool === 'maven' ? `maven:3-eclipse-temurin-${jdk}` : `gradle:jdk${jdk}`;
  return generated(ctx, {
    stack: `java-${tool}`,
    label: `${framework === null ? '' : `${framework} · `}Java ${jdk} · ${tool === 'maven' ? 'Maven' : 'Gradle'}`,
    defaultPort: 8080,
    startCommand: start,
    lines: [
      `FROM ${buildImage} AS build`,
      ...(buildImage.startsWith('gradle:') ? ['USER root', 'ENV GRADLE_USER_HOME=/root/.gradle'] : []),
      'WORKDIR /src',
      'COPY . .',
      run(`chmod +x mvnw gradlew 2>/dev/null || true; ${build} && mkdir -p /out && ${collect}`, JVM_CACHES),
      '',
      `FROM eclipse-temurin:${jdk}-jre`,
      ...runtimePackages(ctx, 'debian'),
      addUser('debian'),
      'WORKDIR /app',
      'COPY --from=build --chown=app:app /out /app',
      'ENV JAVA_OPTS="-XX:MaxRAMPercentage=75" PORT=8080',
      'USER app',
      'EXPOSE 8080',
      cmd(start),
    ],
  });
}

export async function planClojure(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const lein = await exists(join(dir, 'project.clj'));
  const deps = (await readText(join(dir, 'deps.edn'))) ?? '';
  const jdk = roundUp(await jdkRelease(ctx, ''), [17, 21]);
  let build = input.buildCommand ?? (lein ? 'lein uberjar' : /:build\b/.test(deps) ? 'clojure -T:build uber' : /:uberjar\b/.test(deps) ? 'clojure -X:uberjar' : null);
  if (build === null) {
    build = 'clojure -T:build uber';
    warn(ctx, 'deps.edn has no :build or :uberjar alias; add a tools.build alias that produces an uberjar under target/, or set a build command.');
  }
  const collect = `jar=$(find target -name '*-standalone.jar' | head -n1); [ -n "$jar" ] || jar=$(find target -name '*.jar' | head -n1); cp "$jar" /out/app.jar`;
  const start = input.startCommand ?? 'java $JAVA_OPTS -jar /app/app.jar';
  return generated(ctx, {
    stack: 'clojure',
    label: `Clojure · ${lein ? 'Leiningen' : 'tools.deps'} · Java ${jdk}`,
    defaultPort: 8080,
    startCommand: start,
    lines: [
      `FROM clojure:temurin-${jdk}-${lein ? 'lein' : 'tools-deps'} AS build`,
      'WORKDIR /src',
      ...(input.installCommand === null ? [`COPY ${lein ? 'project.clj' : 'deps.edn'} ./`, run(lein ? 'lein deps' : 'clojure -P', JVM_CACHES)] : []),
      'COPY . .',
      ...(input.installCommand === null ? [] : [run(input.installCommand, JVM_CACHES)]),
      run(`${build} && mkdir -p /out && ${collect}`, JVM_CACHES),
      '',
      `FROM eclipse-temurin:${jdk}-jre`,
      ...runtimePackages(ctx, 'debian'),
      addUser('debian'),
      'WORKDIR /app',
      'COPY --from=build --chown=app:app /out/app.jar /app/app.jar',
      'ENV JAVA_OPTS="-XX:MaxRAMPercentage=75" PORT=8080',
      'USER app',
      'EXPOSE 8080',
      cmd(start),
    ],
  });
}
