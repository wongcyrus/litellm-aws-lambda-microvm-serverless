import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cr from "aws-cdk-lib/custom-resources";

export interface PrivateLiteLlmMicrovmStackProps extends cdk.StackProps {
  microvmRegion: string;
  microvmArtifactKey?: string;
  microvmEgressConnectorArn?: string;
  microvmContainerBaseImage?: string;
  useCodebuildEcrBaseImage: boolean;
  readinessCheckNonce: string;
  publicMicrovm: boolean;
}

export class PrivateLiteLlmMicrovmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PrivateLiteLlmMicrovmStackProps) {
    super(scope, id, props);

    const microvmImageName = `${this.stackName}-litellm-bedrock-private`;
    const resolvedMicrovmImageIdentifier = `arn:aws:lambda:${props.microvmRegion}:${this.account}:microvm-image:${microvmImageName}`;

    const subnetConfiguration: ec2.SubnetConfiguration[] = props.publicMicrovm
      ? [
          { name: "AppPublic", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
          { name: "DbPrivate", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }
        ]
      : [
          { name: "AppPublic", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
          { name: "AppPrivate", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
          { name: "DbPrivate", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }
        ];

    const appVpc = new ec2.Vpc(this, "AppVpc", {
      natGateways: props.publicMicrovm ? 0 : 1,
      maxAzs: 2,
      subnetConfiguration
    });

    const microvmSubnetGroupName = props.publicMicrovm ? "AppPublic" : "AppPrivate";
    const microvmSubnets = appVpc.selectSubnets({ subnetGroupName: microvmSubnetGroupName });

    const connectorSecurityGroup = new ec2.SecurityGroup(this, "MicrovmConnectorSecurityGroup", {
      vpc: appVpc,
      description: "Security group to attach to Lambda MicroVM VPC egress connector",
      allowAllOutbound: true
    });

    const artifactBucket = new s3.Bucket(this, "MicrovmArtifactsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    const litellmBaseRepositoryName = "litellm-microvm-base";
    const litellmBaseRepository = new ecr.Repository(this, "LiteLlmBaseRepository", {
      repositoryName: litellmBaseRepositoryName,
      imageScanOnPush: true,
      emptyOnDelete: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    const codebuildRole = new iam.Role(this, "LiteLlmMirrorCodeBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com")
    });
    codebuildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: ["*"]
      })
    );
    codebuildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"]
      })
    );
    litellmBaseRepository.grantPullPush(codebuildRole);
    const litellmMirrorProjectName = `${this.stackName}-litellm-arm64-mirror`;
    new codebuild.CfnProject(this, "LiteLlmArm64MirrorProject", {
      name: litellmMirrorProjectName,
      serviceRole: codebuildRole.roleArn,
      source: {
        type: "NO_SOURCE",
        buildSpec: [
          "version: 0.2",
          "phases:",
          "  pre_build:",
          "    commands:",
          "      - aws --version",
          "      - aws ecr get-login-password --region \"$AWS_DEFAULT_REGION\" | docker login --username AWS --password-stdin \"${TARGET_IMAGE_URI%/*}\"",
          "  build:",
          "    commands:",
          "      - docker pull --platform linux/arm64 \"$SOURCE_IMAGE\"",
          "      - docker tag \"$SOURCE_IMAGE\" \"$TARGET_IMAGE_URI\"",
          "      - docker push \"$TARGET_IMAGE_URI\"",
        ].join("\n")
      },
      artifacts: { type: "NO_ARTIFACTS" },
      environment: {
        type: "LINUX_CONTAINER",
        image: "aws/codebuild/standard:7.0",
        computeType: "BUILD_GENERAL1_MEDIUM",
        privilegedMode: true,
        environmentVariables: [
          { name: "SOURCE_IMAGE", value: "ghcr.io/berriai/litellm-database:main-stable", type: "PLAINTEXT" },
          { name: "TARGET_IMAGE_URI", value: `${litellmBaseRepository.repositoryUri}:main-stable`, type: "PLAINTEXT" },
          { name: "AWS_DEFAULT_REGION", value: this.region, type: "PLAINTEXT" }
        ]
      }
    });

    const endpointSecurityGroup = new ec2.SecurityGroup(this, "VpcEndpointSecurityGroup", {
      vpc: appVpc,
      description: "Security group for private interface endpoints",
      allowAllOutbound: true
    });

    endpointSecurityGroup.addIngressRule(
      connectorSecurityGroup,
      ec2.Port.tcp(443),
      "Allow connector traffic to AWS private endpoints"
    );

    const interfaceServices = ["bedrock-runtime", "bedrock", "secretsmanager", "kms", "logs", "sts"];
    for (const service of interfaceServices) {
      new ec2.InterfaceVpcEndpoint(this, `${toPascalCase(service)}Endpoint`, {
        vpc: appVpc,
        service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${this.region}.${service}`, 443),
        privateDnsEnabled: true,
        securityGroups: [endpointSecurityGroup],
        subnets: { subnetGroupName: microvmSubnetGroupName }
      });
    }

    appVpc.addGatewayEndpoint("S3GatewayEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetGroupName: microvmSubnetGroupName }]
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, "AuroraSecurityGroup", {
      vpc: appVpc,
      description: "Aurora ingress from MicroVM connector only",
      allowAllOutbound: true
    });
    dbSecurityGroup.addIngressRule(connectorSecurityGroup, ec2.Port.tcp(5432), "Allow Aurora from connector");

    const dbCluster = new rds.DatabaseCluster(this, "LiteLlmAuroraCluster", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4
      }),
      writer: rds.ClusterInstance.serverlessV2("writer"),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      defaultDatabaseName: "litellm",
      credentials: rds.Credentials.fromGeneratedSecret("litellm", {
        excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\="
      }),
      vpc: appVpc,
      vpcSubnets: { subnetGroupName: "DbPrivate" },
      securityGroups: [dbSecurityGroup],
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      storageEncrypted: true,
      cloudwatchLogsExports: ["postgresql"]
    });

    const litellmMasterKeySecret = new secretsmanager.Secret(this, "LiteLlmMasterKeySecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ prefix: "sk-" }),
        generateStringKey: "suffix",
        excludePunctuation: true,
        passwordLength: 45
      }
    });
    const apiGatewayKeySecret = new secretsmanager.Secret(this, "AwsGatewayApiKeySecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "apiKey",
        excludePunctuation: true,
        passwordLength: 48
      }
    });
    const proxyCacheTable = new dynamodb.Table(this, "MicrovmProxyCacheTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires_at",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    litellmMasterKeySecret.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    apiGatewayKeySecret.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const microvmBuildRole = new iam.Role(this, "MicrovmBuildRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com")
    });
    microvmBuildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [artifactBucket.arnForObjects("*")]
      })
    );
    microvmBuildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: ["*"]
      })
    );
    microvmBuildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchImportUpstreamImage",
          "ecr:CreateRepository",
          "ecr:DescribeRepositories",
          "ecr-public:GetAuthorizationToken",
          "ecr-public:BatchCheckLayerAvailability",
          "ecr-public:GetDownloadUrlForLayer",
          "ecr-public:BatchGetImage"
        ],
        resources: ["*"]
      })
    );

    const microvmExecutionRole = new iam.Role(this, "MicrovmExecutionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com")
    });
    microvmExecutionRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"));
    microvmExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["*"]
      })
    );
    dbCluster.secret?.grantRead(microvmExecutionRole);

    const connectorOperatorRole = new iam.Role(this, "NetworkConnectorOperatorRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com")
    });
    connectorOperatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
          "ec2:CreateTags",
          "ec2:Describe*"
        ],
        resources: ["*"]
      })
    );

    const managedEgressConnector = props.microvmEgressConnectorArn
      ? undefined
      : new cdk.CfnResource(this, "MicrovmDbEgressConnector", {
          type: "AWS::Lambda::NetworkConnector",
          properties: {
            Configuration: {
              VpcEgressConfiguration: {
                SubnetIds: microvmSubnets.subnetIds,
                SecurityGroupIds: [connectorSecurityGroup.securityGroupId],
                NetworkProtocol: "IPv4",
                AssociatedComputeResourceTypes: ["MicroVm"]
              }
            },
            OperatorRole: connectorOperatorRole.roleArn
          }
        });
    const resolvedEgressConnectorArn = props.microvmEgressConnectorArn ?? managedEgressConnector?.getAtt("Arn").toString();
    const imageDefaultEgressConnectorArn = `arn:aws:lambda:${props.microvmRegion}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;
    const runtimeEgressConnectorArn = resolvedEgressConnectorArn!;

    const proxyLogGroup = new logs.LogGroup(this, "MicrovmAuthProxyLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    const proxyFunction = new lambda.Function(this, "MicrovmAuthProxyFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "microvm_proxy.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda")),
      timeout: cdk.Duration.seconds(29),
      memorySize: 256,
      reservedConcurrentExecutions: 50,
      logGroup: proxyLogGroup,
      environment: {
        MICROVM_REGION: props.microvmRegion,
        MICROVM_PORT: "4000",
        TOKEN_EXPIRATION_MINUTES: "60",
        PROXY_DEPLOY_REV: "3",
        MICROVM_IMAGE_IDENTIFIER: resolvedMicrovmImageIdentifier,
        MICROVM_EXECUTION_ROLE_ARN: microvmExecutionRole.roleArn,
        MICROVM_INGRESS_CONNECTOR_ARN: `arn:aws:lambda:${props.microvmRegion}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
        NETWORK_CONNECTOR_NAME: "litellm-db-egress",
        NETWORK_CONNECTOR_SUBNET_IDS: microvmSubnets.subnetIds.join(","),
        NETWORK_CONNECTOR_SECURITY_GROUP_IDS: connectorSecurityGroup.securityGroupId,
        NETWORK_CONNECTOR_OPERATOR_ROLE_ARN: connectorOperatorRole.roleArn,
        MICROVM_EGRESS_CONNECTOR_ARN: runtimeEgressConnectorArn,
        PROXY_CACHE_TABLE_NAME: proxyCacheTable.tableName
      }
    });
    proxyCacheTable.grantReadWriteData(proxyFunction);
    proxyFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "lambda:CreateMicrovmAuthToken",
          "lambda:ListMicrovms",
          "lambda:GetMicrovm",
          "lambda:GetMicrovmImage",
          "lambda:RunMicrovm",
          "lambda:TerminateMicrovm",
          "lambda:PassNetworkConnector",
          "lambda:CreateNetworkConnector",
          "lambda:ListNetworkConnectors",
          "lambda:GetNetworkConnector",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets"
        ],
        resources: [
          "*",
          `arn:aws:lambda:${props.microvmRegion}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
          `arn:aws:lambda:${props.microvmRegion}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
          ...(props.microvmEgressConnectorArn ? [props.microvmEgressConnectorArn] : [])
        ]
      })
    );
    proxyFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: ["*"]
      })
    );
    proxyFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:CreateServiceLinkedRole"],
        resources: ["*"],
        conditions: {
          StringEquals: { "iam:AWSServiceName": "lambda.amazonaws.com" }
        }
      })
    );

    const apiAccessLogGroup = new logs.LogGroup(this, "PublicLiteLlmApiAccessLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const api = new apigateway.RestApi(this, "PublicLiteLlmApi", {
      restApiName: "litellm-public-proxy",
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      cloudWatchRole: true,
      deployOptions: {
        stageName: "prod",
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false
        })
      },
      apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
      binaryMediaTypes: ["*/*"]
    });
    const proxyIntegration = new apigateway.LambdaIntegration(proxyFunction, { proxy: true });
    const methodOptions: apigateway.MethodOptions = { apiKeyRequired: true };
    api.root.addMethod("ANY", proxyIntegration, methodOptions);
    const greedyProxy = api.root.addResource("{proxy+}");
    greedyProxy.addMethod("ANY", proxyIntegration, methodOptions);

    const usagePlan = api.addUsagePlan("PublicLiteLlmUsagePlan", {
      name: "litellm-public-usage-plan",
      throttle: { rateLimit: 200, burstLimit: 400 },
      quota: { limit: 500000, period: apigateway.Period.MONTH }
    });
    const adminUsagePlan = api.addUsagePlan("AdminLiteLlmUsagePlan", {
      name: "litellm-admin-usage-plan",
      throttle: { rateLimit: 800, burstLimit: 1600 },
      quota: { limit: 500000, period: apigateway.Period.MONTH }
    });
    const awsGatewayApiKey = api.addApiKey("AwsGatewayApiKey", {
      apiKeyName: "litellm-aws-gateway-key",
      value: apiGatewayKeySecret.secretValueFromJson("apiKey").unsafeUnwrap()
    });
    usagePlan.addApiKey(awsGatewayApiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });
    adminUsagePlan.addApiStage({ stage: api.deploymentStage });

    new cdk.CfnOutput(this, "PublicApiInvokeUrl", {
      value: api.url,
      description: "Public API Gateway URL (append LiteLLM root paths after stage)"
    });
    new cdk.CfnOutput(this, "AwsGatewayApiKeyId", {
      value: awsGatewayApiKey.keyId,
      description: "API Gateway key id for the first protection layer"
    });
    new cdk.CfnOutput(this, "AwsGatewayUsagePlanId", {
      value: usagePlan.usagePlanId,
      description: "API Gateway usage plan id used by the public LiteLLM API"
    });
    new cdk.CfnOutput(this, "AwsGatewayAdminUsagePlanId", {
      value: adminUsagePlan.usagePlanId,
      description: "API Gateway usage plan id used for admin/browser workloads"
    });
    new cdk.CfnOutput(this, "AwsGatewayApiKeySecretArn", {
      value: apiGatewayKeySecret.secretArn,
      description: "Secrets Manager ARN containing JSON {\"apiKey\":\"...\"} for x-api-key"
    });

    new logs.LogRetention(this, "PublicLiteLlmApiExecutionLogRetention", {
      logGroupName: cdk.Fn.join("", ["API-Gateway-Execution-Logs_", api.restApiId, "/", api.deploymentStage.stageName]),
      retention: logs.RetentionDays.ONE_WEEK
    });

    let artifactUri: string;
    if (props.microvmArtifactKey) {
      artifactUri = `s3://${artifactBucket.bucketName}/${props.microvmArtifactKey}`;
    } else {
      const deployAccount = process.env.CDK_DEFAULT_ACCOUNT;
      const mirroredBaseImage = deployAccount
        ? `${deployAccount}.dkr.ecr.${props.microvmRegion}.amazonaws.com/${litellmBaseRepositoryName}:main-stable`
        : undefined;
      if (props.useCodebuildEcrBaseImage && !mirroredBaseImage && !props.microvmContainerBaseImage) {
        throw new Error("CDK_DEFAULT_ACCOUNT is required for useCodebuildEcrBaseImage unless microvmContainerBaseImage is explicitly set.");
      }
      const selectedBaseImage = props.microvmContainerBaseImage ?? (props.useCodebuildEcrBaseImage ? mirroredBaseImage : undefined);
      const microvmImageSourceDir = path.join(__dirname, "..", "microvm-image");
      const artifactPath = selectedBaseImage
        ? this.createMicrovmImageSourceWithBaseImage(microvmImageSourceDir, selectedBaseImage)
        : microvmImageSourceDir;
      const defaultArtifact = new s3assets.Asset(this, "DefaultMicrovmImageArtifact", { path: artifactPath });
      artifactUri = defaultArtifact.s3ObjectUrl;
      defaultArtifact.grantRead(microvmBuildRole);
    }

    const microvmImage = new cdk.CfnResource(this, "LiteLlmMicrovmImage", {
      type: "AWS::Lambda::MicrovmImage",
      properties: {
        Name: microvmImageName,
        Description: "LiteLLM Bedrock private image",
        BaseImageArn: `arn:aws:lambda:${props.microvmRegion}:aws:microvm-image:al2023-1`,
        BaseImageVersion: "0",
        BuildRoleArn: microvmBuildRole.roleArn,
        CodeArtifact: { Uri: artifactUri },
        AdditionalOsCapabilities: ["ALL"],
        CpuConfigurations: [{ Architecture: "ARM_64" }],
        Resources: [{ MinimumMemoryInMiB: 2048 }],
        EgressNetworkConnectors: [imageDefaultEgressConnectorArn],
        EnvironmentVariables: [
          {
            Key: "DATABASE_URL",
            Value: cdk.Fn.join("", [
              "postgresql://",
              dbCluster.secret!.secretValueFromJson("username").toString(),
              ":",
              dbCluster.secret!.secretValueFromJson("password").toString(),
              "@",
              dbCluster.clusterEndpoint.hostname,
              ":5432/litellm"
            ])
          },
          {
            Key: "LITELLM_MASTER_KEY",
            Value: cdk.Fn.join("", [
              litellmMasterKeySecret.secretValueFromJson("prefix").toString(),
              litellmMasterKeySecret.secretValueFromJson("suffix").toString()
            ])
          },
          { Key: "STORE_MODEL_IN_DB", Value: "True" },
          { Key: "STORE_PROMPTS_IN_SPEND_LOGS", Value: "True" }
        ],
        Hooks: {},
        Logging: {
          CloudWatch: { LogGroup: cdk.Fn.join("", ["/aws/lambda-microvms/", microvmImageName]) }
        }
      }
    });
    new logs.LogRetention(this, "MicrovmRuntimeLogRetention", {
      logGroupName: cdk.Fn.join("", ["/aws/lambda-microvms/", microvmImageName]),
      retention: logs.RetentionDays.ONE_WEEK
    });
    if (false) {
      const litellmReadyCheckFunction = new lambda.Function(this, "LitellmReadyCheckFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "index.handler",
      timeout: cdk.Duration.minutes(5),
      code: lambda.Code.fromInline(`
import json
import time
import boto3
from botocore.exceptions import ClientError

_lambda = boto3.client("lambda")
_microvms = boto3.client("lambda-microvms")

def _terminate_stack_microvms(microvm_identifier: str):
    paginator = _microvms.get_paginator("list_microvms")
    found_ids = []
    for page in paginator.paginate():
        for item in page.get("items", []):
            image_arn = str(item.get("imageArn") or "")
            if image_arn == microvm_identifier or image_arn.endswith(f":microvm-image:{microvm_identifier}"):
                microvm_id = str(item.get("microvmId") or "")
                state = str(item.get("state") or "")
                if microvm_id and state != "TERMINATED":
                    found_ids.append(microvm_id)

    for microvm_id in found_ids:
        try:
            _microvms.terminate_microvm(microvmIdentifier=microvm_id)
        except ClientError as error:
            code = (error.response.get("Error") or {}).get("Code")
            if code not in {"ResourceNotFoundException", "ValidationException"}:
                raise

def handler(event, context):
    props = event.get("ResourceProperties") or {}
    microvm_identifier = str(props.get("MicrovmImageIdentifier") or "")
    if not microvm_identifier:
        raise RuntimeError("MicrovmImageIdentifier is required for readiness check custom resource.")

    if event.get("RequestType") == "Delete":
        _terminate_stack_microvms(microvm_identifier)
        physical_id = str(event.get("PhysicalResourceId") or "litellm-ready-check")
        return {"PhysicalResourceId": physical_id[:256]}

    function_name = str(props.get("ProxyFunctionName") or "")
    max_attempts = int(props.get("MaxAttempts") or 60)
    delay_seconds = int(props.get("DelaySeconds") or 5)
    nonce = str(props.get("Nonce") or "static")
    if not function_name:
        raise RuntimeError("ProxyFunctionName is required for readiness check.")

    payload = {
        "httpMethod": "GET",
        "path": "/health/liveliness",
        "headers": {},
        "queryStringParameters": None,
        "body": None,
        "isBase64Encoded": False,
    }
    last_status = 0
    last_body = ""
    for _ in range(max_attempts):
        response = _lambda.invoke(
            FunctionName=function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode("utf-8"),
        )
        body = response["Payload"].read()
        result = json.loads(body.decode("utf-8") or "{}")
        last_status = int(result.get("statusCode") or 0)
        last_body = str(result.get("body") or "")
        if last_status == 200:
            return {"PhysicalResourceId": f"litellm-ready-check-{nonce}"}
        time.sleep(delay_seconds)

    raise RuntimeError(f"LiteLLM readiness check failed. lastStatus={last_status}")
      `)
    });
      proxyFunction.grantInvoke(litellmReadyCheckFunction);
      litellmReadyCheckFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["lambda-microvms:ListMicrovms", "lambda-microvms:TerminateMicrovm"],
          resources: ["*"]
        })
      );
      const litellmReadyCheckProvider = new cr.Provider(this, "LitellmReadyCheckProvider", {
        onEventHandler: litellmReadyCheckFunction
      });
      const litellmReadyCheck = new cdk.CustomResource(this, "LitellmReadyCheck", {
        serviceToken: litellmReadyCheckProvider.serviceToken,
        properties: {
          ProxyFunctionName: proxyFunction.functionName,
          MaxAttempts: 60,
          DelaySeconds: 5,
          Nonce: props.readinessCheckNonce,
          MicrovmImageIdentifier: resolvedMicrovmImageIdentifier
        }
      });
      litellmReadyCheck.node.addDependency(microvmImage);
      litellmReadyCheck.node.addDependency(api.deploymentStage);
    }

    new cdk.CfnOutput(this, "MicrovmImageRef", {
      value: microvmImage.ref,
      description: "CloudFormation reference for AWS::Lambda::MicrovmImage"
    });
    new cdk.CfnOutput(this, "AuroraEndpoint", { value: dbCluster.clusterEndpoint.hostname });
    if (dbCluster.secret) {
      new cdk.CfnOutput(this, "AuroraSecretArn", { value: dbCluster.secret.secretArn });
    }
    new cdk.CfnOutput(this, "LiteLlmMasterKeySecretArn", { value: litellmMasterKeySecret.secretArn });
    new cdk.CfnOutput(this, "MicrovmConnectorSubnetIds", {
      value: microvmSubnets.subnetIds.join(","),
      description: "Use these subnets for Lambda MicroVM VPC egress connector"
    });
    new cdk.CfnOutput(this, "MicrovmSubnetMode", {
      value: props.publicMicrovm ? "public" : "private-with-nat",
      description: "MicroVM subnet mode selected by publicMicrovm context"
    });
    new cdk.CfnOutput(this, "MicrovmConnectorSecurityGroupId", {
      value: connectorSecurityGroup.securityGroupId,
      description: "Attach this SG to Lambda MicroVM VPC egress connector"
    });
    new cdk.CfnOutput(this, "MicrovmBuildRoleArn", { value: microvmBuildRole.roleArn });
    new cdk.CfnOutput(this, "MicrovmExecutionRoleArn", { value: microvmExecutionRole.roleArn });
    new cdk.CfnOutput(this, "MicrovmArtifactBucketName", { value: artifactBucket.bucketName });
    new cdk.CfnOutput(this, "LiteLlmBaseEcrRepositoryUri", { value: litellmBaseRepository.repositoryUri });
    new cdk.CfnOutput(this, "LiteLlmArm64MirrorCodeBuildProjectName", { value: litellmMirrorProjectName });
    new cdk.CfnOutput(this, "NetworkConnectorOperatorRoleArn", { value: connectorOperatorRole.roleArn });
    new cdk.CfnOutput(this, "MicrovmProxyCacheTableName", { value: proxyCacheTable.tableName });
  }

  private createMicrovmImageSourceWithBaseImage(sourceDir: string, baseImage: string): string {
    const dockerfilePath = path.join(sourceDir, "Dockerfile");
    const configPath = path.join(sourceDir, "config.yaml");
    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    const rewrittenDockerfile = dockerfile.replace(/^FROM\s+.+$/m, `FROM ${baseImage}`);
    const generatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "litellm-microvm-image-"));
    fs.writeFileSync(path.join(generatedDir, "Dockerfile"), rewrittenDockerfile, "utf8");
    fs.copyFileSync(configPath, path.join(generatedDir, "config.yaml"));
    return generatedDir;
  }
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
