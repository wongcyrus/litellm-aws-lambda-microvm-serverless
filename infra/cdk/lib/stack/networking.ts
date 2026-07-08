import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export type NetworkingResources = {
  appVpc: ec2.Vpc;
  microvmSubnets: ec2.SelectedSubnets;
  connectorSecurityGroup: ec2.SecurityGroup;
  dbSecurityGroup: ec2.SecurityGroup;
};

export function createNetworkingResources(
  scope: cdk.Stack,
  options: { publicMicrovm: boolean; region: string }
): NetworkingResources {
  const subnetConfiguration: ec2.SubnetConfiguration[] = [
    { name: "AppPublic", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
    {
      name: "AppPrivate",
      subnetType: options.publicMicrovm ? ec2.SubnetType.PRIVATE_ISOLATED : ec2.SubnetType.PRIVATE_WITH_EGRESS,
      cidrMask: 24
    },
    { name: "DbPrivate", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }
  ];

  const appVpc = new ec2.Vpc(scope, "AppVpc", {
    natGateways: options.publicMicrovm ? 0 : 1,
    maxAzs: 2,
    subnetConfiguration
  });

  const microvmSubnetGroupName = options.publicMicrovm ? "AppPublic" : "AppPrivate";
  const microvmSubnets = appVpc.selectSubnets({ subnetGroupName: microvmSubnetGroupName });

  const connectorSecurityGroup = new ec2.SecurityGroup(scope, "MicrovmConnectorSecurityGroup", {
    vpc: appVpc,
    description: "Security group to attach to Lambda MicroVM VPC egress connector",
    allowAllOutbound: true
  });

  const endpointSecurityGroup = new ec2.SecurityGroup(scope, "VpcEndpointSecurityGroup", {
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
    new ec2.InterfaceVpcEndpoint(scope, `${toPascalCase(service)}Endpoint`, {
      vpc: appVpc,
      service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${options.region}.${service}`, 443),
      privateDnsEnabled: true,
      securityGroups: [endpointSecurityGroup],
      subnets: { subnetGroupName: microvmSubnetGroupName }
    });
  }

  appVpc.addGatewayEndpoint("S3GatewayEndpoint", {
    service: ec2.GatewayVpcEndpointAwsService.S3,
    subnets: [{ subnetGroupName: microvmSubnetGroupName }]
  });

  const dbSecurityGroup = new ec2.SecurityGroup(scope, "AuroraSecurityGroup", {
    vpc: appVpc,
    description: "Aurora ingress from MicroVM connector only",
    allowAllOutbound: true
  });
  dbSecurityGroup.addIngressRule(connectorSecurityGroup, ec2.Port.tcp(5432), "Allow Aurora from connector");

  return {
    appVpc,
    microvmSubnets,
    connectorSecurityGroup,
    dbSecurityGroup
  };
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
