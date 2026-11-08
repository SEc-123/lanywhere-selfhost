#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
typedef uint8_t u8;typedef uint16_t u16;typedef uint32_t u32;typedef uint64_t u64;typedef int32_t Result;
typedef struct {int active;} Service;typedef Service TipcService;
typedef struct {u64 value;} SmServiceName;
typedef enum {SetLanguage_ENUS=1,SetLanguage_ZHCN=6,SetLanguage_ZHTW=11,SetLanguage_ZHHANS=15,SetLanguage_ZHHANT=16} SetLanguage;
#define R_FAILED(x) ((x)!=0)
#define R_SUCCEEDED(x) ((x)==0)
#define MAKERESULT(m,d) ((m)*512+(d))
#define Module_Libnx 345
#define LibnxError_BadInput 2
#define HidNpadButton_A 1
typedef struct {int out_num_objects;Service*out_objects;} MockParams;
#ifdef __cplusplus
extern "C" {
#endif
Result mockDispatch(Service*,u32,const void*,size_t,void*,size_t,MockParams);
bool serviceIsActive(Service*);void serviceClose(Service*);
Result smGetService(Service*,const char*);SmServiceName smEncodeName(const char*);TipcService*smGetServiceSessionTipc(void);
Result setInitialize(void);void setExit(void);Result setGetSystemLanguage(u64*);Result setMakeLanguage(u64,SetLanguage*);
u64 armGetSystemTick(void);u64 armGetSystemTickFreq(void);
#ifdef __cplusplus
}
#endif
#define serviceDispatch(s,c,...) mockDispatch((s),(c),NULL,0,NULL,0,(MockParams){__VA_ARGS__})
#define serviceDispatchOut(s,c,o,...) mockDispatch((s),(c),NULL,0,&(o),sizeof(o),(MockParams){__VA_ARGS__})
#define serviceDispatchIn(s,c,i,...) mockDispatch((s),(c),&(i),sizeof(i),NULL,0,(MockParams){__VA_ARGS__})
#define tipcDispatchInOut(s,c,i,o) mockDispatch((s),(c),&(i),sizeof(i),&(o),sizeof(o),(MockParams){0})
