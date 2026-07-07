import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";

export type ImageArtifactResources = {
  artifactBucket: s3.Bucket;
  litellmBaseRepository: ecr.Repository;
  litellmBaseRepositoryName: string;
  litellmMirrorProjectName: string;
};

export function createImageArtifactResources(scope: cdk.Stack): ImageArtifactResources {
  const artifactBucket = new s3.Bucket(scope, "MicrovmArtifactsBucket", {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    autoDeleteObjects: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY
  });

  const litellmBaseRepositoryName = "litellm-microvm-base";
  const litellmBaseRepository = new ecr.Repository(scope, "LiteLlmBaseRepository", {
    repositoryName: litellmBaseRepositoryName,
    imageScanOnPush: true,
    emptyOnDelete: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY
  });

  const codebuildRole = new iam.Role(scope, "LiteLlmMirrorCodeBuildRole", {
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

  const litellmMirrorProjectName = `${scope.stackName}-litellm-arm64-mirror`;
  new codebuild.CfnProject(scope, "LiteLlmArm64MirrorProject", {
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
        "      - docker push \"$TARGET_IMAGE_URI\""
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
        { name: "AWS_DEFAULT_REGION", value: scope.region, type: "PLAINTEXT" }
      ]
    }
  });

  return {
    artifactBucket,
    litellmBaseRepository,
    litellmBaseRepositoryName,
    litellmMirrorProjectName
  };
}
