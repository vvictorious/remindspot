Pod::Spec.new do |s|
  s.name           = 'ThereYouGoLocationNotification'
  s.version        = '0.1.0'
  s.summary        = 'Schedules iOS Smart Arrival region monitoring for ThereYouGo.'
  s.description    = 'A narrow local Expo module for managed CLCircularRegion registration, observation recovery, and local reminder delivery.'
  s.author         = 'Victor Mejia'
  s.homepage       = 'https://github.com/vvictorious/remindspot'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => 'https://github.com/vvictorious/remindspot.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
