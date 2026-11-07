import { createDatabasePool, initialOwnerId } from "../../packages/database/src/pool.js";
import { acquireAdmission } from "../../services/api/src/admission-service.js";
try {
  const pool=createDatabasePool(process.env.TEST_DATABASE_URL!,1);
  const owner=await initialOwnerId(pool);
  const result=await acquireAdmission(pool,owner,"crashed-process-request",{key:"provider",windowSeconds:60,maxRequests:9,maxConcurrent:1,leaseSeconds:1,durableRequest:true});
  if(!result.allowed||!result.leaseId)process.exit(1);
  process.stdout.write(JSON.stringify({leaseId:result.leaseId,ownerUserId:owner}),()=>process.exit(0)); // No completion/release.
}catch{process.exit(1);}
