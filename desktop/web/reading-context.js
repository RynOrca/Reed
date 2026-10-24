// Scene lifetime is separate from composer state. Every submission receives an
// immutable snapshot; changing pages afterwards cannot alter an in-flight turn.
export function createReadingContext(){
  let current=null,sessionId='';
  return {session(id){if(id!==sessionId){sessionId=id;current=null;}},set(value){current=value?{...value,sessionId,capturedAt:Date.now()}:null;},clear(){current=null;},snapshot(){return current?structuredClone(current):null;}};
}
