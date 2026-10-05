/**
 * Ready-to-paste snippets for the file store docs: every SDK and tool gets
 * the store's real endpoint, region, bucket and access key filled in. The
 * secret is a placeholder unless the caller knows it.
 */
export type Sdk = 'node' | 'python' | 'php' | 'go' | 'java' | 'dotnet' | 'ruby' | 'django' | 'cli' | 'rclone' | 's3cmd' | 'mc';
export const SDKS: Sdk[] = ['node', 'python', 'php', 'go', 'java', 'dotnet', 'ruby', 'django', 'cli', 'rclone', 's3cmd', 'mc'];
export const SDK_LABELS: Record<Sdk, string> = {
  node: 'Node.js',
  python: 'Python',
  php: 'PHP / Laravel',
  go: 'Go',
  java: 'Java',
  dotnet: '.NET',
  ruby: 'Ruby',
  django: 'Django',
  cli: 'AWS CLI',
  rclone: 'rclone',
  s3cmd: 's3cmd',
  mc: 'MinIO mc',
};

export interface SnippetInput {
  endpoint: string;
  region: string;
  key: string;
  secret: string;
  bucket: string;
}

export function sdkSnippet(sdk: Sdk, v: SnippetInput): string {
  const { endpoint, region, key, secret, bucket } = v;
  switch (sdk) {
    case 'node':
      return [
        '// npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner',
        "import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';",
        "import { getSignedUrl } from '@aws-sdk/s3-request-presigner';",
        '',
        'const s3 = new S3Client({',
        `  endpoint: process.env.S3_ENDPOINT ?? '${endpoint}',`,
        `  region: process.env.S3_REGION ?? '${region}',`,
        '  forcePathStyle: true, // required: endpoint/bucket/key',
        `  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '${key}', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '${secret}' },`,
        '});',
        `const Bucket = '${bucket}';`,
        '',
        '// upload',
        "await s3.send(new PutObjectCommand({ Bucket, Key: 'avatars/u1.png', Body: buffer, ContentType: 'image/png' }));",
        '// list',
        "const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: 'avatars/' }));",
        '// temporary download link (1 hour) for a private bucket',
        "const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: 'avatars/u1.png' }), { expiresIn: 3600 });",
        '// temporary upload link: the browser PUTs the file straight into the store',
        "const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket, Key: 'uploads/doc.pdf', ContentType: 'application/pdf' }), { expiresIn: 600 });",
      ].join('\n');
    case 'python':
      return [
        '# pip install boto3',
        'import os, boto3',
        'from botocore.config import Config',
        '',
        's3 = boto3.client(',
        "    's3',",
        `    endpoint_url=os.getenv('S3_ENDPOINT', '${endpoint}'),`,
        `    aws_access_key_id=os.getenv('S3_ACCESS_KEY_ID', '${key}'),`,
        `    aws_secret_access_key=os.getenv('S3_SECRET_ACCESS_KEY', '${secret}'),`,
        `    region_name='${region}',`,
        "    config=Config(s3={'addressing_style': 'path'}, signature_version='s3v4'),",
        ')',
        `BUCKET = '${bucket}'`,
        '',
        "s3.upload_file('report.pdf', BUCKET, 'reports/2026-10.pdf', ExtraArgs={'ContentType': 'application/pdf'})",
        "s3.download_file(BUCKET, 'reports/2026-10.pdf', '/tmp/report.pdf')",
        "for obj in s3.list_objects_v2(Bucket=BUCKET, Prefix='reports/').get('Contents', []):",
        "    print(obj['Key'], obj['Size'])",
        '# temporary link (1 hour)',
        "url = s3.generate_presigned_url('get_object', Params={'Bucket': BUCKET, 'Key': 'reports/2026-10.pdf'}, ExpiresIn=3600)",
      ].join('\n');
    case 'php':
      return [
        '// composer require league/flysystem-aws-s3-v3   (Laravel 9+)',
        "// .env",
        `AWS_ACCESS_KEY_ID=${key}`,
        `AWS_SECRET_ACCESS_KEY=${secret}`,
        `AWS_DEFAULT_REGION=${region}`,
        `AWS_BUCKET=${bucket}`,
        `AWS_ENDPOINT=${endpoint}`,
        'AWS_USE_PATH_STYLE_ENDPOINT=true',
        '',
        "// config/filesystems.php already reads these for the 's3' disk.",
        "Storage::disk('s3')->put('avatars/u1.png', $contents, 'public');",
        "$url = Storage::disk('s3')->temporaryUrl('invoices/42.pdf', now()->addHour()); // private bucket",
        "$public = Storage::disk('s3')->url('avatars/u1.png');                        // public bucket",
        '',
        '// Plain PHP (aws/aws-sdk-php):',
        "$s3 = new Aws\\S3\\S3Client(['version' => 'latest', 'region' => '" + region + "', 'endpoint' => '" + endpoint + "',",
        "  'use_path_style_endpoint' => true, 'credentials' => ['key' => '" + key + "', 'secret' => '" + secret + "']]);",
        "$s3->putObject(['Bucket' => '" + bucket + "', 'Key' => 'avatars/u1.png', 'Body' => $contents, 'ContentType' => 'image/png']);",
      ].join('\n');
    case 'go':
      return [
        '// go get github.com/aws/aws-sdk-go-v2/{config,credentials,service/s3}',
        'cfg, err := config.LoadDefaultConfig(ctx,',
        `    config.WithRegion("${region}"),`,
        `    config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("${key}", "${secret}", "")),`,
        ')',
        'client := s3.NewFromConfig(cfg, func(o *s3.Options) {',
        `    o.BaseEndpoint = aws.String("${endpoint}")`,
        '    o.UsePathStyle = true',
        '})',
        '',
        `_, err = client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String("${bucket}"), Key: aws.String("avatars/u1.png"), Body: file, ContentType: aws.String("image/png")})`,
        '',
        '// temporary link (1 hour)',
        'presigner := s3.NewPresignClient(client)',
        `req, err := presigner.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: aws.String("${bucket}"), Key: aws.String("avatars/u1.png")}, s3.WithPresignExpires(time.Hour))`,
        'fmt.Println(req.URL)',
      ].join('\n');
    case 'java':
      return [
        '// software.amazon.awssdk:s3 (AWS SDK v2)',
        'S3Client s3 = S3Client.builder()',
        `    .endpointOverride(URI.create("${endpoint}"))`,
        `    .region(Region.of("${region}"))`,
        `    .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("${key}", "${secret}")))`,
        '    .forcePathStyle(true)',
        '    .build();',
        '',
        `s3.putObject(PutObjectRequest.builder().bucket("${bucket}").key("avatars/u1.png").contentType("image/png").build(), RequestBody.fromFile(path));`,
        '',
        '// temporary link (1 hour)',
        'S3Presigner presigner = S3Presigner.builder()',
        `    .endpointOverride(URI.create("${endpoint}")).region(Region.of("${region}"))`,
        `    .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("${key}", "${secret}")))`,
        '    .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();',
        'String url = presigner.presignGetObject(GetObjectPresignRequest.builder().signatureDuration(Duration.ofHours(1))',
        `    .getObjectRequest(GetObjectRequest.builder().bucket("${bucket}").key("avatars/u1.png").build()).build()).url().toString();`,
      ].join('\n');
    case 'dotnet':
      return [
        '// dotnet add package AWSSDK.S3',
        'var config = new AmazonS3Config {',
        `    ServiceURL = "${endpoint}",`,
        '    ForcePathStyle = true,',
        `    AuthenticationRegion = "${region}",`,
        '};',
        `var s3 = new AmazonS3Client("${key}", "${secret}", config);`,
        '',
        `await s3.PutObjectAsync(new PutObjectRequest { BucketName = "${bucket}", Key = "avatars/u1.png", FilePath = path, ContentType = "image/png" });`,
        '',
        '// temporary link (1 hour)',
        `var url = s3.GetPreSignedURL(new GetPreSignedUrlRequest { BucketName = "${bucket}", Key = "avatars/u1.png", Expires = DateTime.UtcNow.AddHours(1) });`,
      ].join('\n');
    case 'ruby':
      return [
        "# gem 'aws-sdk-s3'",
        'require "aws-sdk-s3"',
        '',
        'client = Aws::S3::Client.new(',
        `  endpoint: "${endpoint}",`,
        `  region: "${region}",`,
        `  access_key_id: "${key}",`,
        `  secret_access_key: "${secret}",`,
        '  force_path_style: true,',
        ')',
        `bucket = Aws::S3::Resource.new(client: client).bucket("${bucket}")`,
        '',
        'bucket.object("avatars/u1.png").upload_file("u1.png", content_type: "image/png")',
        'url = bucket.object("invoices/42.pdf").presigned_url(:get, expires_in: 3600) # temporary link',
        '',
        '# Rails Active Storage (config/storage.yml):',
        '# torexploy:',
        '#   service: S3',
        `#   endpoint: ${endpoint}`,
        `#   region: ${region}`,
        `#   bucket: ${bucket}`,
        '#   force_path_style: true',
        '#   access_key_id: <%= ENV["S3_ACCESS_KEY_ID"] %>',
        '#   secret_access_key: <%= ENV["S3_SECRET_ACCESS_KEY"] %>',
      ].join('\n');
    case 'django':
      return [
        '# pip install django-storages boto3',
        '# settings.py',
        'STORAGES = {',
        '    "default": {',
        '        "BACKEND": "storages.backends.s3.S3Storage",',
        '        "OPTIONS": {',
        `            "endpoint_url": "${endpoint}",`,
        `            "region_name": "${region}",`,
        `            "bucket_name": "${bucket}",`,
        `            "access_key": "${key}",`,
        `            "secret_key": "${secret}",`,
        '            "addressing_style": "path",',
        '            "signature_version": "s3v4",',
        '            "querystring_auth": True,   # private bucket: temporary links',
        '            "default_acl": None,',
        '        },',
        '    },',
        '}',
        '',
        '# models.py',
        'class Document(models.Model):',
        '    file = models.FileField(upload_to="documents/")',
        '',
        '# doc.file.url -> temporary link (private bucket) or direct link (public bucket)',
      ].join('\n');
    case 'cli':
      return [
        '# pip install awscli  (or the official installer)',
        `aws configure set aws_access_key_id ${key}`,
        `aws configure set aws_secret_access_key ${secret}`,
        `aws configure set region ${region}`,
        '',
        `aws --endpoint-url ${endpoint} s3 ls`,
        `aws --endpoint-url ${endpoint} s3 cp ./photo.png s3://${bucket}/photos/photo.png`,
        `aws --endpoint-url ${endpoint} s3 sync ./public s3://${bucket}/site --delete`,
        `aws --endpoint-url ${endpoint} s3 presign s3://${bucket}/photos/photo.png --expires-in 3600`,
      ].join('\n');
    case 'rclone':
      return [
        `rclone config create torexploy s3 provider=Other endpoint=${endpoint} access_key_id=${key} secret_access_key=${secret} region=${region} force_path_style=true`,
        '',
        `rclone lsd torexploy:`,
        `rclone copy ./photos torexploy:${bucket}/photos --progress`,
        `rclone sync ./backups torexploy:${bucket}/backups --progress`,
        `rclone mount torexploy:${bucket} /mnt/files --vfs-cache-mode writes   # mount as a folder`,
      ].join('\n');
    case 's3cmd':
      return [
        `s3cmd --configure   # answer: Access Key ${key}, Secret ${secret}, S3 Endpoint ${endpoint.replace(/^https?:\/\//, '')}`,
        `# or put these in ~/.s3cfg:`,
        `host_base = ${endpoint.replace(/^https?:\/\//, '')}`,
        `host_bucket = ${endpoint.replace(/^https?:\/\//, '')}`,
        `use_https = ${endpoint.startsWith('https') ? 'True' : 'False'}`,
        `access_key = ${key}`,
        `secret_key = ${secret}`,
        '',
        `s3cmd ls s3://${bucket}/`,
        `s3cmd put ./photo.png s3://${bucket}/photos/photo.png`,
      ].join('\n');
    case 'mc':
      return [
        `mc alias set torexploy ${endpoint} ${key} ${secret} --api S3v4 --path on`,
        '',
        `mc ls torexploy/${bucket}`,
        `mc cp ./photo.png torexploy/${bucket}/photos/photo.png`,
        `mc mirror ./public torexploy/${bucket}/site`,
        `mc share download torexploy/${bucket}/photos/photo.png --expire 1h`,
      ].join('\n');
  }
}

/** The variables a linked application receives, with the prefix chosen on the link. */
export function linkEnvRows(prefix: string, internalEndpoint: string, region: string, key: string): [string, string, string][] {
  return [
    [`${prefix}S3_ENDPOINT`, internalEndpoint, 'endpoint'],
    [`${prefix}S3_ACCESS_KEY_ID`, key, 'key'],
    [`${prefix}S3_SECRET_ACCESS_KEY`, '••••••••', 'secret'],
    [`${prefix}S3_REGION`, region, 'region'],
    [`${prefix}S3_FORCE_PATH_STYLE`, 'true', 'pathStyle'],
    [`${prefix}S3_BUCKET`, '', 'bucket'],
    [`${prefix}AWS_ENDPOINT_URL`, internalEndpoint, 'aws'],
    [`${prefix}AWS_ACCESS_KEY_ID`, key, 'aws'],
    [`${prefix}AWS_SECRET_ACCESS_KEY`, '••••••••', 'aws'],
    [`${prefix}AWS_REGION`, region, 'aws'],
  ];
}

export function linkedAppSnippet(prefix: string): string {
  const p = prefix;
  return [
    '// The linked app reads its variables; nothing is hard-coded.',
    "import { S3Client } from '@aws-sdk/client-s3';",
    '',
    'const s3 = new S3Client({',
    `  endpoint: process.env.${p}S3_ENDPOINT,`,
    `  region: process.env.${p}S3_REGION,`,
    `  forcePathStyle: process.env.${p}S3_FORCE_PATH_STYLE === 'true',`,
    `  credentials: { accessKeyId: process.env.${p}S3_ACCESS_KEY_ID!, secretAccessKey: process.env.${p}S3_SECRET_ACCESS_KEY! },`,
    '});',
    '',
    '# Python',
    `s3 = boto3.client('s3', endpoint_url=os.environ['${p}S3_ENDPOINT'], aws_access_key_id=os.environ['${p}S3_ACCESS_KEY_ID'],`,
    `                  aws_secret_access_key=os.environ['${p}S3_SECRET_ACCESS_KEY'], region_name=os.environ['${p}S3_REGION'],`,
    "                  config=Config(s3={'addressing_style': 'path'}))",
  ].join('\n');
}

export function browserUploadSnippet(): string {
  return [
    '// 1) Server: issue a temporary upload link (any SDK above does this with a PutObject presign)',
    "app.post('/api/upload-url', async (req, res) => {",
    "  const Key = `uploads/${crypto.randomUUID()}-${req.body.name}`;",
    "  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, ContentType: req.body.type }), { expiresIn: 600 });",
    '  res.json({ url, key: Key });',
    '});',
    '',
    '// 2) Browser: send the file straight to the store, bypassing your server',
    "const { url, key } = await fetch('/api/upload-url', { method: 'POST', body: JSON.stringify({ name: file.name, type: file.type }), headers: { 'content-type': 'application/json' } }).then((r) => r.json());",
    "await fetch(url, { method: 'PUT', body: file, headers: { 'content-type': file.type } });",
    "// 3) Save `key` in your database; serve it later with a GET presign (private) or a direct link (public bucket).",
  ].join('\n');
}

export function panelApiSnippet(base: string, serviceId: string, bucket: string): string {
  return [
    '# Create an API token: Settings → API tokens. Send it as a Bearer token.',
    `TOKEN=ploy_…`,
    `BASE=${base}/api/services/${serviceId}/storage`,
    '',
    '# buckets and keys',
    `curl -H "Authorization: Bearer $TOKEN" $BASE/buckets`,
    `curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST $BASE/buckets -d '{"name":"${bucket}","public":false}'`,
    `curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST $BASE/keys -d '{"name":"ci-uploader","buckets":["${bucket}"],"permission":"readwrite"}'`,
    '',
    '# objects: upload, list, temporary link, delete',
    `curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: image/png" -X PUT --data-binary @photo.png "$BASE/buckets/${bucket}/objects/photos/photo.png"`,
    `curl -H "Authorization: Bearer $TOKEN" "$BASE/buckets/${bucket}/objects?prefix=photos/"`,
    `curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/buckets/${bucket}/presign" -d '{"key":"photos/photo.png","method":"get","expiresIn":3600}'`,
    `curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/buckets/${bucket}/delete" -d '{"keys":["photos/photo.png"]}'`,
  ].join('\n');
}
