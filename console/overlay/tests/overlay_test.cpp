#include <cassert>
#include <algorithm>
#include <vector>
#define main overlay_entry_main
#include "../source/main.cpp"
#undef main
static u32 enabled=1,logging=0,protocol=5,fail_command=0;
static bool present=true,ignore_set=false;static int opens=0,sets=0;static u64 ticks=1;
static LanywhereOverlayStatus status{};static LanywhereOverlayMatch match{};static std::vector<u32>commands;
extern "C" {
Result mockDispatch(Service*,u32 command,const void*in,size_t,void*out,size_t size,MockParams params){
 commands.push_back(command);
 if(command==fail_command){if(out)std::memset(out,0xff,size);return 1;}
 if(command==65000){params.out_objects->active=1;return 0;}
 if(command==65001){std::memset(out,'v',size);return 0;}
 if(command==65002||command==65004){if(size==1){*(u8*)out=present;return 0;}*(u32*)out=command==65002?logging:enabled;return 0;}
 if(command==65100){*(u8*)out=present;return 0;}
 if(command==65003||command==65005){++sets;if(!ignore_set)(command==65003?logging:enabled)=*(const u32*)in;return 0;}
 if(command==10){*(u32*)out=protocol;return 0;}
 if(command==3){std::memcpy(out,&status,size);return 0;}if(command==9){std::memcpy(out,&match,size);return 0;}
 assert(false);return 1;
}
bool serviceIsActive(Service*s){return s->active!=0;}void serviceClose(Service*s){s->active=0;}
Result smGetService(Service*s,const char*){++opens;s->active=1;return 0;}
SmServiceName smEncodeName(const char*){return {1};}TipcService*smGetServiceSessionTipc(){static Service s{1};return &s;}
Result setInitialize(){return 0;}void setExit(){}Result setGetSystemLanguage(u64*out){*out=0;return 0;}Result setMakeLanguage(u64,SetLanguage*out){*out=SetLanguage_ENUS;return 0;}
u64 armGetSystemTick(){return ticks;}u64 armGetSystemTickFreq(){return 1000;}
}
void reset(){enabled=1;logging=0;protocol=5;fail_command=0;present=true;ignore_set=false;opens=sets=0;ticks=1;status={};match={};commands.clear();g_chinese=false;closeServices();}
int main(){
 reset();connectServices();assert(g_snapshot.config_ok&&g_snapshot.relay_ok&&g_snapshot.enabled&&opens==2);
 // The actual IPC reader terminates a completely non-NUL 32-byte module version.
 assert(g_version[31]==0&&std::strlen(g_version)==31);
 SafeToggle plugin(false),log(true);assert(!plugin.onClick(2)&&sets==0);assert(plugin.onClick(1)&&enabled==0&&sets==1&&!plugin.getState());
 assert(plugin.onClick(1)&&enabled==1&&sets==2&&plugin.getState());
 for(u8 state:{u8(1),u8(2),u8(3)}){status.state=state;int before=sets;plugin.onClick(1);assert(sets==before&&enabled==1);}
 status.state=0;
 for(u8 state:{u8(1),u8(2),u8(3),u8(4),u8(5)}){match.state=state;int before=sets;plugin.onClick(1);assert(sets==before);}
 match.state=0;fail_command=3;int before=sets;plugin.onClick(1);assert(sets==before&&!g_snapshot.relay_ok&&g_snapshot.status.state==0);
 fail_command=65005;plugin.onClick(1);assert(enabled==1&&plugin.getState()&&g_notice.find("failed")!=std::string::npos);
 fail_command=0;ignore_set=true;plugin.onClick(1);assert(plugin.getState()&&g_notice.find("failed")!=std::string::npos);ignore_set=false;
 status.state=2;log.onClick(1);assert(logging==1&&log.getState());
 fail_command=65002;refresh();assert(!g_snapshot.config_ok);before=sets;log.onClick(1);assert(sets==before);
 reset();present=false;connectServices();assert(opens==0&&!g_snapshot.config_ok&&!g_snapshot.relay_ok);
 reset();protocol=999;connectServices();assert(g_protocol_mismatch&&!g_snapshot.relay_ok&&!serviceIsActive(&g_relay));
 reset();connectServices();status.state=2;status.member_count=2;std::memcpy(status.code,"ABCDEF",6);refresh();
 MainGui gui;std::unique_ptr<tsl::elm::Element>ui(gui.createUI());auto*frame=dynamic_cast<tsl::elm::OverlayFrame*>(ui.get());assert(frame&&frame->title=="LANywhere");
 auto*list=dynamic_cast<tsl::elm::List*>(frame->content);bool room=false,players=false;for(auto*p:list->items){auto*i=dynamic_cast<tsl::elm::ListItem*>(p);if(!i)continue;room|=i->text=="Room"&&i->value=="ABCDEF";players|=i->text=="Room members"&&i->value=="2 / 8";}assert(room&&players);
 auto requests=commands.size();gui.update();assert(commands.size()==requests);ticks+=1000;gui.update();assert(commands.size()>requests);
 Overlay overlay;before=sets;commands.clear();overlay.onHide();overlay.exitServices();assert(sets==before&&commands.empty());
 // Failed IPC cannot leak stale, partial or malformed replies into status controls.
 reset();Service s{1};LanywhereOverlayStatus out;std::memset(&out,0xaa,sizeof(out));fail_command=3;assert(R_FAILED(lanywhereOverlayGetStatus(&s,&out))&&out.state==0&&out.error[0]==0);
 fail_command=0;status.state=4;assert(R_FAILED(lanywhereOverlayGetStatus(&s,&out)));status={};status.state=2;status.member_count=9;assert(R_FAILED(lanywhereOverlayGetStatus(&s,&out)));
 LanywhereOverlayMatch mout;match.state=9;assert(R_FAILED(lanywhereOverlayGetMatch(&s,&mout)));
 reset();connectServices();g_chinese=true;assert(std::strcmp(connectionLabel(),"未加入房间")==0);status.state=2;refresh();assert(std::strcmp(connectionLabel(),"已加入房间")==0);
 status.state=1;std::strcpy(status.error,"Reconnecting to the room.");refresh();assert(std::strcmp(connectionLabel(),"正在重连")==0);
 status.state=3;std::strcpy(status.error,"Room session expired. Rejoin from the game.");refresh();assert(std::strcmp(connectionLabel(),"会话已过期")==0);
 std::strcpy(status.error,"Room changed during recovery. Rejoin from the game.");refresh();assert(std::strcmp(connectionLabel(),"房间已变化")==0);
 std::strcpy(status.error,"Could not reconnect. Check Wi-Fi and rejoin.");refresh();assert(std::strcmp(connectionLabel(),"重连未成功")==0);
 // No room CREATE/JOIN/LEAVE, list discovery or filesystem preference write API exists in this overlay.
 for(u32 c:commands)assert(c!=0&&c!=1&&c!=2&&c!=4&&c!=6&&c!=7&&c!=8&&c!=11&&c!=12);
 std::puts("Actual overlay IPC + UI: status, protocol/missing-service gates, bounded polling, safe toggles, readback failures, close-without-leave and Chinese labels passed");
}
