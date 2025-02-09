import { KubectlV24Layer } from '@aws-cdk/lambda-layer-kubectl-v24';
import { App, Stack, StackProps } from 'aws-cdk-lib';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { Cluster, CoreDnsComputeType, KubernetesVersion } from 'aws-cdk-lib/aws-eks';
import { ManagedPolicy, Role, ServicePrincipal, PolicyDocument } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import { Karpenter } from '../src';

class TestEKSStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'testVPC', {
      natGateways: 1,
    });

    const clusterRole = new Role(this, 'clusterRole', {
      assumedBy: new ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSVPCResourceController'),
      ],
    });

    const cluster = new Cluster(this, 'testCluster', {
      vpc: vpc,
      role: clusterRole,
      version: KubernetesVersion.V1_24, // OCI HELM repo only supported by new version.
      defaultCapacity: 0,
      coreDnsComputeType: CoreDnsComputeType.FARGATE,
      kubectlLayer: new KubectlV24Layer(this, 'KubectlLayer'), // new Kubectl lambda layer
    });

    cluster.addFargateProfile('karpenter', {
      selectors: [
        {
          namespace: 'karpenter',
        },
        {
          namespace: 'kube-system',
          labels: {
            'k8s-app': 'kube-dns',
          },
        },
      ],
    });

    var ssmPolicy = ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore');

    // Create the role resource
    const nodeRole = new Role(this, 'custom-karpenter-role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
    });

    // Add the policy to the role
    nodeRole.addManagedPolicy(ssmPolicy);

    const karpenter = new Karpenter(this, 'Karpenter', {
      cluster: cluster,
      version: 'v0.27.0', // test the newest version
      nodeRole: nodeRole,
    });

    karpenter.addNodeTemplate('spot-template', {
      subnetSelector: {
        Name: `${this.stackName}/${vpc.node.id}/PrivateSubnet*`,
      },
      securityGroupSelector: {
        'aws:eks:cluster-name': cluster.clusterName,
      },
      metadataOptions: {
        httpTokens: 'optional',
      },
    });

    karpenter.addProvisioner('spot-provisioner', {
      requirements: [{
        key: 'karpenter.sh/capacity-type',
        operator: 'In',
        values: ['spot'],
      }],
      limits: {
        resources: {
          cpu: 20,
        },
      },
      providerRef: {
        name: 'spot-template',
      },
    });

    const policyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'Statement',
          Effect: 'Allow',
          Action: 's3:ListAllMyBuckets',
          Resource: '*',
        },
      ],
    };

    const customPolicyDocument = PolicyDocument.fromJson(policyDocument);

    const newManagedPolicy = new ManagedPolicy(this, 'MyNewManagedPolicy', {
      document: customPolicyDocument,
    });

    karpenter.addManagedPolicyToKarpenterRole(newManagedPolicy);

    karpenter.addManagedPolicyToKarpenterRole(ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
  }
}

const app = new App();

new TestEKSStack(app, 'test', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

app.synth();