import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cr from "aws-cdk-lib/custom-resources";
import { createMicrovmImageSourceDir } from "./microvm-image-source";
import { createNetworkingResources } from "./stack/networking";
import { createImageArtifactResources } from "./stack/image-artifacts";
import { IAM_KEY_BOOTSTRAP_INLINE_CODE } from "./stack/iam-key-bootstrap-code";

export interface PrivateLiteLlmMicrovmStackProps extends cdk.StackProps {
  microvmRegion: string;
  vertexAiProject?: string;
  vertexAiLocation?: string;
  vertexCredentialsJson?: string;
  azureApiBase?: string;
  azureApiKey?: string;
  azureApiVersion?: string;
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
    const vertexProviderEnabled = Boolean(props.vertexAiProject && props.vertexAiLocation && props.vertexCredentialsJson);
    const azureProviderEnabled = Boolean(props.azureApiBase && props.azureApiKey && props.azureApiVersion);

    const microvmImageName = `${this.stackName}-litellm-bedrock-private`;
    const resolvedMicrovmImageIdentifier = `arn:aws:lambda:${props.microvmRegion}:${this.account}:microvm-image:${microvmImageName}`;

    const { appVpc, microvmSubnets, connectorSecurityGroup, dbSecurityGroup } = createNetworkingResources(this, {
      publicMicrovm: props.publicMicrovm,
      region: this.region
    });
    const { artifactBucket, litellmBaseRepository, litellmBaseRepositoryName, litellmMirrorProjectName } =
      createImageArtifactResources(this);

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
    const iamPrincipalKeyMapTable = new dynamodb.Table(this, "IamPrincipalKeyMapTable", {
      partitionKey: { name: "principal_arn", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    const iamRouteCallerRole = new iam.Role(this, "IamRouteCallerRole", {
      roleName: `${this.stackName}-iam-route-caller`,
      assumedBy: new iam.AccountPrincipal(this.account),
      description: "Role for clients using /iam/* route with AWS_IAM auth"
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
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        ConnectorEc2Access: new iam.PolicyDocument({
          statements: [
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
          ]
        })
      }
    });

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
        PROXY_CACHE_TABLE_NAME: proxyCacheTable.tableName,
        IAM_KEY_MAP_TABLE_NAME: iamPrincipalKeyMapTable.tableName,
        IAM_ROUTE_PREFIX: "/iam"
      }
    });
    proxyCacheTable.grantReadWriteData(proxyFunction);
    iamPrincipalKeyMapTable.grantReadData(proxyFunction);
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
    const iamRoot = api.root.addResource("iam");
    const iamMethodOptions: apigateway.MethodOptions = { authorizationType: apigateway.AuthorizationType.IAM };
    iamRoot.addMethod("ANY", proxyIntegration, iamMethodOptions);
    iamRoot.addResource("{proxy+}").addMethod("ANY", proxyIntegration, iamMethodOptions);
    iamRouteCallerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [api.arnForExecuteApi("*", "/iam/*", api.deploymentStage.stageName)]
      })
    );

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
      const artifactPath = createMicrovmImageSourceDir(microvmImageSourceDir, {
        baseImage: selectedBaseImage,
        enableAzure: azureProviderEnabled,
        enableVertex: vertexProviderEnabled
      });
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
          { Key: "VERTEXAI_PROJECT", Value: props.vertexAiProject ?? "" },
          { Key: "VERTEXAI_LOCATION", Value: props.vertexAiLocation ?? "" },
          { Key: "VERTEX_CREDENTIALS", Value: props.vertexCredentialsJson ?? "" },
          { Key: "AZURE_API_BASE", Value: props.azureApiBase ?? "" },
          { Key: "AZURE_API_KEY", Value: props.azureApiKey ?? "" },
          { Key: "AZURE_API_VERSION", Value: props.azureApiVersion ?? "" },
          { Key: "STORE_MODEL_IN_DB", Value: "False" },
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
    const microvmCleanupFunction = new lambda.Function(this, "MicrovmCleanupFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "microvm_cleanup.handler",
      timeout: cdk.Duration.minutes(5),
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda")),
      environment: {
        MICROVM_REGION: props.microvmRegion
      }
    });
    microvmCleanupFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:ListMicrovms", "lambda:TerminateMicrovm"],
        resources: ["*"]
      })
    );
    const microvmCleanupProvider = new cr.Provider(this, "MicrovmCleanupProvider", {
      onEventHandler: microvmCleanupFunction
    });
    const microvmCleanup = new cdk.CustomResource(this, "MicrovmCleanupOnDelete", {
      serviceToken: microvmCleanupProvider.serviceToken,
      properties: {
        MicrovmImageIdentifier: resolvedMicrovmImageIdentifier
      }
    });
    microvmCleanup.node.addDependency(microvmImage);
    const iamKeyMappingBootstrapFunction = new lambda.Function(this, "IamKeyMappingBootstrapFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "index.handler",
      timeout: cdk.Duration.minutes(5),
      code: lambda.Code.fromInline(IAM_KEY_BOOTSTRAP_INLINE_CODE)
    });
    iamPrincipalKeyMapTable.grantReadWriteData(iamKeyMappingBootstrapFunction);
    litellmMasterKeySecret.grantRead(iamKeyMappingBootstrapFunction);
    proxyFunction.grantInvoke(iamKeyMappingBootstrapFunction);
    const iamKeyMappingBootstrapProvider = new cr.Provider(this, "IamKeyMappingBootstrapProvider", {
      onEventHandler: iamKeyMappingBootstrapFunction
    });
    const iamKeyMappingBootstrap = new cdk.CustomResource(this, "IamKeyMappingBootstrap", {
      serviceToken: iamKeyMappingBootstrapProvider.serviceToken,
      properties: {
        PrincipalArn: iamRouteCallerRole.roleArn,
        TableName: iamPrincipalKeyMapTable.tableName,
        ProxyFunctionName: proxyFunction.functionName,
        MasterKeySecretArn: litellmMasterKeySecret.secretArn,
        KeyAlias: "iam-route-default",
        Duration: "3650d"
      }
    });
    iamKeyMappingBootstrap.node.addDependency(proxyFunction);
    iamKeyMappingBootstrap.node.addDependency(microvmImage);
    iamKeyMappingBootstrap.node.addDependency(iamRouteCallerRole);
    iamKeyMappingBootstrap.node.addDependency(iamPrincipalKeyMapTable);

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
    new cdk.CfnOutput(this, "IamPrincipalKeyMapTableName", { value: iamPrincipalKeyMapTable.tableName });
    new cdk.CfnOutput(this, "IamRouteCallerRoleArn", { value: iamRouteCallerRole.roleArn });
  }
}
