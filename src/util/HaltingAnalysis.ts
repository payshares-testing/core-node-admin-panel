import {
  NetworkGraphNode,
  QuorumSet as NetworkQuorumSet
} from "../Types/NetworkTypes";

// Represents a failure case where a set of N nodes can take down your network
export type HaltingFailure = {
  // The nodes which can go down and cause havoc
  vulnerableNodes: NetworkGraphNode[];
  // The nodes which will go down in response to the vulnerable nodes
  affectedNodes: NetworkGraphNode[];
};

type AnalysisNode = {
  name: string;
  live: boolean;
  quorumSet: AnalysisQuorumSet;
  dependentsNames: string[];
  networkObject: NetworkGraphNode;
};

type AnalysisQuorumSet = {
  threshold: number;
  dependencies: (string | AnalysisQuorumSet)[];
};

// Type guards for determining dependency types
function isQuorumSet(n: string | AnalysisQuorumSet): n is AnalysisQuorumSet {
  return (<AnalysisQuorumSet>n).threshold !== undefined;
}

function isNested(
  set: string[] | NetworkQuorumSet[]
): set is NetworkQuorumSet[] {
  return typeof set[0] != "string";
}

// Create the data structure needed for analysis
// Returns tuple of root node and an array of all nodes
export function createAnalysisStructure(
  nodes: NetworkGraphNode[]
): { root: AnalysisNode; entries: AnalysisNode[] } {
  const myNode = nodes.find(n => n.distance == 0);
  if (!myNode) {
    throw new Error("No node with distance 0 in halting analysis");
  }

  const entryCache: Map<String, AnalysisNode> = new Map<String, AnalysisNode>();
  const root = generateNode(myNode);
  function generateNode(node: NetworkGraphNode): AnalysisNode {
    const cached = entryCache.get(node.node);
    if (cached) return cached;

    const entry: AnalysisNode = {
      networkObject: node,
      name: node.node,
      live: true,
      quorumSet: {
        threshold: node.qset.t,
        dependencies: []
      },
      dependentsNames: []
    };
    entryCache.set(entry.name, entry);

    generateQuorumset(node.qset, entry);
    function generateQuorumset(set: NetworkQuorumSet, entry: AnalysisNode) {
      if (isNested(set.v)) {
        set.v.forEach(set => {
          generateQuorumset(set, entry);
        });
      } else {
        set.v.forEach(dependentName => {
          const dependentNetworkNode = nodes.find(n => n.node == dependentName);
          if (!dependentNetworkNode) {
            throw new Error(
              "Bad network graph: no node named " + dependentName
            );
          }
          const depNode = generateNode(dependentNetworkNode);
          entry.quorumSet.dependencies.push(depNode.name);
          depNode.dependentsNames.push(entry.name);
        });
      }
    }

    return entry;
  }

  return { root, entries: Array.from(entryCache.values()) };
}

// Reset any analysis data between passes
function reset(nodes: AnalysisNode[]) {
  nodes.forEach(n => (n.live = true));
}

/*
 * Run the halting analysis on a node graph. Iterate through making each node faulty and seeing what quorums
 * it affects, and whether or not it halts your own node.
 * @param {number} numberOfNodesToTest - Maximum number of nodes to fault test at each pass
 * @return {HaltingFailure[]} List of failure cases
 */
export function haltingAnalysis(
  nodes: NetworkGraphNode[],
  numberOfNodesToTest: number = 1
): HaltingFailure[] {
  if (numberOfNodesToTest != 1) {
    throw new Error("Halting analysis only supports order 1 at this point");
  }
  const failureCases: HaltingFailure[] = [];
  const { root, entries: analysisNodes } = createAnalysisStructure(nodes);
  function getNode(name: string): AnalysisNode {
    return analysisNodes.find(n => n.name == name) as AnalysisNode;
  }
  // Actual analysis
  // Run through each node and observe the effects of failing it
  analysisNodes.forEach(nodeToHalt => {
    if (nodeToHalt === root) return;

    reset(analysisNodes);

    let deadNodes: NetworkGraphNode[] = [];

    nodeToHalt.live = false;
    checkDependents(nodeToHalt);
    /*
     * Check all the nodes that are dependent on this newly dead node to see if they go
     * down as well
     * @param { AnalysisNode } deadNode - A node that is no longer live
     */
    function checkDependents(deadNode: AnalysisNode) {
      deadNode.dependentsNames.forEach(nodeName => {
        const dependentNode = getNode(nodeName);
        // If this node is currently live, but can't make threshold it
        // goes down, and this error can propagate out.
        if (
          dependentNode.live &&
          !quorumSetMeetsThreshold(dependentNode.quorumSet)
        ) {
          dependentNode.live = false;
          deadNodes.push(dependentNode.networkObject);
          checkDependents(dependentNode);
        }
      });
    }

    /*
     *  Check if this quorum set has enough live nodes to validate
     *  @param { AnalysisQuorumSet } quorum - Quorum set to test
     *  @return { boolean } true if this quorum set meets its threshold of valid nodes
     */

    function quorumSetMeetsThreshold(quorum: AnalysisQuorumSet): boolean {
      let threshold = quorum.threshold;
      quorum.dependencies.forEach(dependent => {
        if (isQuorumSet(dependent)) {
          if (quorumSetMeetsThreshold(dependent)) {
            threshold--;
          }
        } else {
          let dependentNode = getNode(dependent);
          if (dependentNode.live) {
            threshold--;
          } else {
            deadNodes.push(dependentNode.networkObject);
          }
        }
      });
      return threshold <= 0;
    }

    if (!root.live) {
      deadNodes = Array.from(new Set(deadNodes));
      failureCases.push({
        vulnerableNodes: [nodeToHalt.networkObject],
        affectedNodes: deadNodes
      });
    }
  });
  return failureCases;
}