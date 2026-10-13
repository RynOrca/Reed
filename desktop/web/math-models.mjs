export const MATH_SPECS = {
  'quadratic-v1': {a:[-3,3],h:[-4,4],k:[-4,4],x:[-5,5]},
  'linear-transform-2d-v1': {a:[-3,3],b:[-3,3],c:[-3,3],d:[-3,3],vx:[-3,3],vy:[-3,3],t:[0,1]},
};
export function validMathState(kind,state) {
  const spec=Object.hasOwn(MATH_SPECS,kind)?MATH_SPECS[kind]:null;
  return !!spec && !!state && typeof state==='object' && !Array.isArray(state) && Object.keys(state).length===Object.keys(spec).length &&
    Object.entries(spec).every(([key,[min,max]])=>Object.hasOwn(state,key)&&Number.isFinite(state[key])&&state[key]>=min&&state[key]<=max);
}
export function quadraticValues({a,h,k,x}) {
  return {y:a*(x-h)**2+k,slope:2*a*(x-h),vertex:[h,k],at:q=>a*(q-h)**2+k};
}
export function linearValues({a,b,c,d,vx,vy,t}) {
  const matrix=[1+t*(a-1),t*b,t*c,1+t*(d-1)];
  const [m00,m01,m10,m11]=matrix;
  return {matrix,determinant:a*d-b*c,currentDeterminant:m00*m11-m01*m10,vector:[m00*vx+m01*vy,m10*vx+m11*vy],
    targetVector:[a*vx+b*vy,c*vx+d*vy],transform:(x,y)=>[m00*x+m01*y,m10*x+m11*y]};
}
